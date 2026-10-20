/**
 * 流水线阶段实现（v0.6.0）
 *
 * 每个阶段只做一件事，输入是 assets 行，输出是"可重建的派生数据"。
 * 关键纪律：
 *  - 不在持有数据库写事务时做哈希/解包/图片编码（repo 的写方法都是短事务；I/O 全在事务外）；
 *  - 每个阶段都有取消检查点（signal），并由 pipeline 统一设超时；
 *  - 超限不是"失败"，是 limited 降级：保留基础记录，写清原因，允许调大限制后重跑；
 *  - 任何阶段失败都不得删除素材 / 标签 / 收藏 / 分类 / 用户图片（只写派生表）。
 */
import { basename, join } from "node:path";
import { statSync, writeFileSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import type { AssetRow } from "../../../../../packages/core/src/contracts";
import type { Repo } from "../../db/repo";
import type { MediaStore } from "../media";
import type { CacheLike } from "./cache";
import { cacheKey } from "./cache";
import type { PipelineLimits } from "./limits";

export type Stage = "hash" | "archive" | "unitypackage" | "thumbs" | "meta" | "categorize" | "fts";

export const STAGE_ORDER: Stage[] = ["hash", "archive", "unitypackage", "thumbs", "meta", "categorize", "fts"];

export interface StageResult {
  limited?: { code: "BYTES" | "ENTRIES" | "PIXELS" | "RATIO" | "TIMEOUT" | "UNSUPPORTED"; message: string } | null;
  note?: string;
  itemsTotal?: number;
  bytesTotal?: number;
  /** 明确跳过（不适用），不是失败 */
  skipped?: string | null;
}

export interface StageCtx {
  repo: Repo;
  media: MediaStore;
  cache: CacheLike;
  limits: PipelineLimits;
  log: (m: string) => void;
  signal: AbortSignal;
  progress: (p: { bytesDone?: number; bytesTotal?: number; itemsDone?: number; itemsTotal?: number }) => void;
}

export class CancelledError extends Error {
  readonly code = "CANCELLED";
  constructor(msg = "cancelled") { super(msg); this.name = "CancelledError"; }
}
export class LimitedError extends Error {
  readonly code: string;
  constructor(code: string, msg: string) { super(msg); this.name = "LimitedError"; this.code = code; }
}

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new CancelledError(String(signal.reason ?? "cancelled"));
}

/** 磁盘现状（safeStat 的返回）：身份校验必须看**磁盘**，不能只看 DB 行。 */
export interface LiveStat { size: number; mtimeMs: number; ino: number; dev: number }

/** mtime 比较容差（ms）：ISO 串是四舍五入、mtimeMs 带亚毫秒小数，实测差 <0.002ms；留 2ms 抗 FS 抖动。 */
const MTIME_TOLERANCE_MS = 2;

/** DB 行 mtime（ISO 串）→ 毫秒；缺失/非法返回 NaN。绝不用 new Date(mtimeMs).toISOString() 反推（会截断差 1ms）。 */
function rowMtimeMs(a: Pick<AssetRow, "mtime">): number {
  return a.mtime ? Date.parse(a.mtime) : NaN;
}

/** 磁盘文件是否仍是"算这个 sha 的那份"：size 相同且 mtime 在容差内。 */
function liveMatchesRow(a: Pick<AssetRow, "size" | "mtime">, live: LiveStat): boolean {
  const rowMs = rowMtimeMs(a);
  return Number(live.size) === Number(a.size || 0)
    && Number.isFinite(rowMs)
    && Math.abs(Math.round(live.mtimeMs) - rowMs) <= MTIME_TOLERANCE_MS;
}

/**
 * 内容身份（v0.6.1-B 缓存身份安全）：
 *  - 强身份 `sha256:<sha>` **仅在** sha256_state==="ok" 且磁盘与行一致时成立；
 *    否则说明文件已被替换，旧 sha 用来做缓存键会污染强键（审计 F3）。
 *  - 弱身份 `weak:<assetId>:<path_norm>:<size>:<mtimeMs>[:<ino>:<dev>]`：只对"同一资产同一路径同一份文件"有效，
 *    跨资产/跨路径绝不共键（审计 F1：旧写法 size:mtime 不含路径，两个不同文件会撞键并发错目录）。
 *    ino/dev 仅在有效（>0）时追加：换文件会让 inode 变化 → 键变 → miss，挡住"同路径同 size+mtime 的替换"；
 *    Windows 上 ino 可能为 0/不稳定，此时退化为不含 ino 的旧格式，避免缓存空转。
 *  - live 缺省（文件读不到）时退化为弱身份，仍带 assetId+path_norm。
 */
export function contentIdentity(
  a: Pick<AssetRow, "id" | "path_norm" | "sha256" | "sha256_state" | "size" | "mtime">,
  live?: LiveStat | null,
): { identity: string; weak: boolean } {
  if (a.sha256 && a.sha256_state === "ok" && live && liveMatchesRow(a, live)) {
    return { identity: "sha256:" + a.sha256, weak: false };
  }
  const size = live ? Number(live.size) : Number(a.size || 0);
  const mtimeMs: number | string = live
    ? Math.round(live.mtimeMs)
    : (Number.isFinite(rowMtimeMs(a)) ? rowMtimeMs(a) : String(a.mtime ?? ""));
  const base = `weak:${a.id}:${a.path_norm}:${size}:${mtimeMs}`;
  // ino/dev 只在有效时追加（见函数头说明：Windows 上可能为 0，不追加以免缓存空转）
  const ino = live ? Number(live.ino) : 0;
  const dev = live ? Number(live.dev) : 0;
  return { identity: ino > 0 && dev > 0 ? `${base}:${ino}:${dev}` : base, weak: true };
}

export function fingerprintOf(a: Pick<AssetRow, "size" | "mtime">): string {
  return Number(a.size || 0) + ":" + String(a.mtime ?? "");
}

/** 内容采样字节数：首尾各 64 KiB（合计最多 128 KiB/资产）。 */
export const CONTENT_SAMPLE_BYTES = 64 * 1024;

/**
 * 内容采样指纹（task-33 / AUD-03 修复）：sha256(head 64KiB + tail 64KiB + size) 的前 16 hex。
 *
 * 为什么需要：身份 (size, mtime, ino, dev) 全是**元数据**，"同路径同 size+mtime 的内容替换"
 * （cp -p 就地覆盖 / 写后 utimes 回写 / ext2-3 inode 复用）在元数据上完全不可见，
 * 会把旧目录当成新文件的（AUD-03 S3b/S4/S9b/S10）；陈旧 sha 时还会把新内容写进旧 sha 强键（S5/S6）。
 *
 * 语义：
 *  - 文件读不了 / 采样期间文件变了（size 与 stat 不一致、读不满）→ 返回 null，
 *    调用方必须**绕过缓存**（不 get 不 put）：绝不能把"没采到样"当成"内容相同"。
 *  - 只读首尾各 64 KiB，远端盘/大包也不会变成全量哈希（成本 1-3ms）。
 */
export async function contentSample(file: string, sizeHint?: number): Promise<string | null> {
  let fh;
  try { fh = await open(file, "r"); } catch { return null; }
  try {
    const st = await fh.stat();
    const size = Number(st.size);
    if (Number.isFinite(sizeHint) && Number(sizeHint) !== size) return null; // stat 与采样之间被替换
    const len = Math.min(CONTENT_SAMPLE_BYTES, Math.max(0, size));
    const head = Buffer.alloc(len);
    const tail = Buffer.alloc(len);
    const tailPos = Math.max(0, size - len);
    const rHead = len ? await fh.read(head, 0, len, 0) : { bytesRead: 0 };
    const rTail = len ? await fh.read(tail, 0, len, tailPos) : { bytesRead: 0 };
    if (rHead.bytesRead !== len || rTail.bytesRead !== len) return null; // 读不满 = 采样不可信
    const h = createHash("sha256");
    h.update(head); h.update(tail); h.update(String(size));
    return h.digest("hex").slice(0, 16);
  } catch {
    return null;
  } finally {
    try { await fh.close(); } catch { /* ignore */ }
  }
}

/** 动态取 core 的新版本导出；core-content 落地前用旧实现兜底（签名兼容）。 */
async function coreHash() {
  const m: any = await import("../../../../../packages/core/src/hash");
  return {
    chunked: (m.sha256FileChunked ?? (async (file: string, opts: any = {}) => {
      const r = await m.sha256FileWithSize(file);
      opts.onProgress?.(r.bytes, r.bytes);
      return r;
    })) as (file: string, opts?: any) => Promise<{ sha256: string; bytes: number }>,
    version: Number(m.HASH_VERSION ?? 1),
  };
}
async function coreArchive() {
  const m: any = await import("../../../../../packages/core/src/archive/list");
  return { list: m.listArchive as any, read: m.readArchiveEntry as any, version: Number(m.ARCHIVE_PARSER_VERSION ?? 1) };
}
async function coreUnityPackage() {
  const m: any = await import("../../../../../packages/core/src/unitypackage");
  return { list: m.listUnityPackage as any, preview: m.readUnityPackagePreview as any, version: Number(m.UNITYPACKAGE_PARSER_VERSION ?? 1) };
}

const IMAGE_EXT = /(^|\.)(png|jpe?g|webp|gif|bmp|tga|psd)$/i;

/** 阶段 A：流式哈希（常量内存、可取消、带进度）。 */
export async function stageHash(ctx: StageCtx, asset: AssetRow): Promise<StageResult> {
  const st = safeStat(asset.path);
  if (!st) return { skipped: "file missing" };
  if (ctx.limits.maxHashBytes > 0 && st.size > ctx.limits.maxHashBytes) {
    ctx.repo.setAssetSha(asset.id, null, "error");
    return { limited: { code: "BYTES", message: "文件 " + st.size + " 字节超过哈希上限 " + ctx.limits.maxHashBytes + "，未计算 sha256" } };
  }
  const h = await coreHash();
  let done = 0;
  const r = await h.chunked(asset.path, {
    signal: ctx.signal,
    chunkSize: ctx.limits.hashChunkBytes,
    onProgress: (bytes: number, total: number | null) => {
      done = bytes;
      ctx.progress({ bytesDone: bytes, bytesTotal: total ?? st.size });
    },
  });
  checkAbort(ctx.signal);
  // 哈希期间文件被改写/替换（同尺寸改写、边下边扫）→ digest 是"混合内容"，绝不能写成 ok（否则污染强身份键）
  const after = safeStat(asset.path);
  const unchanged = !!after
    && after.size === st.size
    && after.ino === st.ino
    && after.dev === st.dev
    && Math.round(after.mtimeMs) === Math.round(st.mtimeMs);
  if (!unchanged) {
    ctx.repo.setAssetSha(asset.id, null, "error");
    ctx.log("hash asset " + asset.id + " file changed during hash, sha discarded");
    return { bytesTotal: r.bytes, itemsTotal: 0, skipped: "file changed during hash" };
  }
  ctx.repo.setAssetSha(asset.id, r.sha256, "ok");
  ctx.repo.setAssetContentVersion(asset.id, fingerprintOf(asset));
  ctx.progress({ bytesDone: done, bytesTotal: r.bytes, itemsDone: 1, itemsTotal: 1 });
  return { bytesTotal: r.bytes, itemsTotal: 1, note: "sha256=" + r.sha256.slice(0, 12) };
}

/** 阶段 B1：压缩包目录（带缓存；缓存键 = 内容身份 + 解析器版本 + 限制指纹）。 */
export async function stageArchive(ctx: StageCtx, asset: AssetRow): Promise<StageResult> {
  const st = safeStat(asset.path);
  if (!st) return { skipped: "file missing" };
  if (ctx.limits.maxArchiveBytes > 0 && st.size > ctx.limits.maxArchiveBytes) {
    return { limited: { code: "BYTES", message: "压缩包 " + st.size + " 字节超过解析上限 " + ctx.limits.maxArchiveBytes + "，已跳过目录解析" } };
  }
  const core = await coreArchive();
  // 身份取**磁盘现状**（st 是 safeStat 的结果）：文件在排队期间被替换时，DB 行是旧值，不能拿它当身份
  const { identity, weak } = contentIdentity(asset, st);
  // 内容采样（task-33）：把"元数据看不见的内容变化"带进键；采不到样就绕过缓存（不 get 不 put）
  const sample = await contentSample(asset.path, st.size);
  const key = cacheKey({
    kind: "archive-listing",
    identity,
    versionKey: "archive:" + asset.container + ":v" + core.version,
    limitsHash: cacheKey({ kind: "limits", identity: "l", versionKey: "", extra: {
      maxEntries: ctx.limits.maxArchiveEntries, maxEntryBytes: ctx.limits.maxEntryBytes,
      maxTotalReadBytes: ctx.limits.maxTotalReadBytes, maxCompressionRatio: ctx.limits.maxCompressionRatio,
    } }),
    extra: { sample: sample ?? "unreadable" },
  });
  // 强身份命中时校验条目记录的 content_sha（防 DB 行被改/旧实现写入的脏条目）；弱身份没有 sha 可比
  const cached = sample === null ? null : await ctx.cache.get<any>("archive-listing", key, weak ? undefined : { contentSha: String(asset.sha256 ?? "") });
  if (cached && Array.isArray(cached.entries)) {
    checkAbort(ctx.signal);
    applyArchiveListing(ctx.repo, asset.id, cached.entries);
    ctx.progress({ itemsDone: cached.entries.length, itemsTotal: cached.entries.length });
    return { itemsTotal: cached.entries.length, note: "cache hit" + (weak ? " (weak identity)" : ""), limited: cached.limited ?? null };
  }

  const listing: any = await core.list(asset.path, {
    maxEntries: ctx.limits.maxArchiveEntries,
    maxEntryBytes: ctx.limits.maxEntryBytes,
    maxTotalBytes: ctx.limits.maxTotalReadBytes,
    maxCompressionRatio: ctx.limits.maxCompressionRatio,
    signal: ctx.signal,
  });
  checkAbort(ctx.signal);
  const entries = (listing.entries ?? []).map((e: any) => ({ path: e.path, size: Number(e.size) || 0, isDir: !!e.isDir }));
  applyArchiveListing(ctx.repo, asset.id, entries);
  const limited = listing.limited ?? (listing.truncated ? { code: "ENTRIES", message: "条目超过上限 " + ctx.limits.maxArchiveEntries + "，目录已截断" } : null);
  if (sample !== null) {
    await ctx.cache.put("archive-listing", key, { entries, limited, passwordProtected: !!listing.passwordProtected, truncated: !!listing.truncated }, {
      kind: "archive-listing", contentSha: weak ? null : String(asset.sha256 ?? ""), versionKey: "archive:v" + core.version, weak,
    });
  } else {
    ctx.log("archive asset " + asset.id + " content sample unreadable, cache bypassed");
  }
  ctx.progress({ itemsDone: entries.length, itemsTotal: entries.length });
  return { itemsTotal: entries.length, note: "entries=" + entries.length + (limited ? " (truncated)" : "") + (sample === null ? "; sample unreadable (cache bypassed)" : ""), limited };
}

function applyArchiveListing(repo: Repo, assetId: number, entries: { path: string; size: number; isDir: boolean }[]): void {
  repo.replaceArchiveEntries(assetId, entries.map((e) => ({ path: e.path, size: e.size, isDir: e.isDir, ext: (e.path.match(/\.[^./]+$/) ?? [""])[0].toLowerCase() })));
}

/** 阶段 B2：unitypackage 结构（缓存键同样带版本）。 */
export async function stageUnityPackage(ctx: StageCtx, asset: AssetRow): Promise<StageResult> {
  const st = safeStat(asset.path);
  if (!st) return { skipped: "file missing" };
  if (ctx.limits.maxArchiveBytes > 0 && st.size > ctx.limits.maxArchiveBytes) {
    return { limited: { code: "BYTES", message: "unitypackage " + st.size + " 字节超过解析上限 " + ctx.limits.maxArchiveBytes } };
  }
  const core = await coreUnityPackage();
  // 同 stageArchive：身份取磁盘现状 + 内容采样
  const { identity, weak } = contentIdentity(asset, st);
  const sample = await contentSample(asset.path, st.size);
  const key = cacheKey({
    kind: "upkg-listing", identity, versionKey: "upkg:v" + core.version,
    // 审计 F6：maxTotalReadBytes 会改变结果（预算命中会提前停止），必须进 limitsHash
    limitsHash: cacheKey({ kind: "limits", identity: "u", versionKey: "", extra: {
      maxAssets: ctx.limits.maxUnityPackageAssets, maxEntryBytes: ctx.limits.maxEntryBytes, maxTotalReadBytes: ctx.limits.maxTotalReadBytes,
    } }),
    extra: { sample: sample ?? "unreadable" },
  });
  const cached = sample === null ? null : await ctx.cache.get<any>("upkg-listing", key, weak ? undefined : { contentSha: String(asset.sha256 ?? "") });
  if (cached && Array.isArray(cached.assets)) {
    checkAbort(ctx.signal);
    applyUpkgListing(ctx.repo, asset.id, cached.assets);
    ctx.progress({ itemsDone: cached.assets.length, itemsTotal: cached.assets.length });
    return { itemsTotal: cached.assets.length, note: "cache hit" + (weak ? " (weak identity)" : ""), limited: cached.limited ?? null };
  }
  const listing: any = await core.list(asset.path, {
    maxAssets: ctx.limits.maxUnityPackageAssets,
    maxEntryBytes: ctx.limits.maxEntryBytes,
    maxTotalBytes: ctx.limits.maxTotalReadBytes,
    signal: ctx.signal,
  });
  checkAbort(ctx.signal);
  const assets = (listing.assets ?? []).map((a: any) => ({ guid: String(a.guid), assetPath: String(a.assetPath), type: a.type ?? null, size: a.size ?? null, hasPreview: !!a.hasPreview }));
  applyUpkgListing(ctx.repo, asset.id, assets);
  const limited = listing.limited ?? (listing.truncated ? { code: "ENTRIES", message: "资产数超过上限 " + ctx.limits.maxUnityPackageAssets } : null);
  if (sample !== null) {
    await ctx.cache.put("upkg-listing", key, { assets, limited, truncated: !!listing.truncated }, {
      kind: "upkg-listing", contentSha: weak ? null : String(asset.sha256 ?? ""), versionKey: "upkg:v" + core.version, weak,
    });
  } else {
    ctx.log("unitypackage asset " + asset.id + " content sample unreadable, cache bypassed");
  }
  ctx.progress({ itemsDone: assets.length, itemsTotal: assets.length });
  return { itemsTotal: assets.length, note: "assets=" + assets.length + (sample === null ? "; sample unreadable (cache bypassed)" : ""), limited };
}

function applyUpkgListing(repo: Repo, assetId: number, assets: any[]): void {
  repo.replaceUnityPackageAssets(assetId, assets);
}

/** 阶段 C：缩略图（独立队列；缓存命中不重复解码；失败保留已有封面）。 */
export async function stageThumbs(ctx: StageCtx, asset: AssetRow): Promise<StageResult> {
  const st = safeStat(asset.path);
  if (!st) return { skipped: "file missing" };
  const itemId = asset.item_id;
  const existing = new Set((ctx.repo.listImages(itemId) as any[]).map((i) => i.sha256).filter(Boolean));
  let saved = 0;
  let failed = 0;
  let limited: StageResult["limited"] = null;

  const save = async (buf: Buffer, extHint: string) => {
    if (buf.length > ctx.limits.maxImageBytes) { failed++; return; }
    const r = await ctx.media.saveImage(itemId, buf, extHint, { maxPixels: ctx.limits.maxImagePixels, maxSize: ctx.limits.thumbMaxSize });
    if (existing.has(r.sha256)) return;
    ctx.repo.addImage(itemId, { role: asset.container === "unitypackage" ? "package_preview" : "archive_frame", origin: "archive", file_path: r.filePath, thumb_path: r.thumbPath, width: r.width, height: r.height, bytes: r.bytes, sha256: r.sha256 });
    existing.add(r.sha256);
    saved++;
    ctx.progress({ itemsDone: saved, itemsTotal: Math.max(saved, 1) });
  };

  try {
    if (asset.container === "unitypackage") {
      const core = await coreUnityPackage();
      const rows = (ctx.repo.getUnityPackageAssets(asset.id) as any[]).filter((a) => a.hasPreview).slice(0, ctx.limits.maxThumbsPerAsset);
      for (const a of rows) {
        checkAbort(ctx.signal);
        try {
          const buf = await core.preview(asset.path, String(a.guid), { maxBytes: ctx.limits.maxImageBytes, signal: ctx.signal });
          if (buf) await save(buf, "png");
        } catch (e) {
          if (e instanceof CancelledError) throw e;
          if (String((e as any)?.code ?? "") === "CANCELLED") throw new CancelledError();
          failed++;
        }
      }
    } else if (asset.container === "zip") {
      // 7z/rar 的条目直读成本高且现有产品口径就是"不抽内嵌图"；zip 才做外层图片帧抽取。
      const core = await coreArchive();
      const entries = (ctx.repo.getArchiveEntries(asset.id) as any[])
        .filter((e) => !e.isDir && IMAGE_EXT.test(String(e.path)) && Number(e.size) > 1024 && Number(e.size) <= ctx.limits.maxImageBytes)
        .sort((a, b) => Number(b.size) - Number(a.size))
        .slice(0, ctx.limits.maxThumbsPerAsset);
      for (const e of entries) {
        checkAbort(ctx.signal);
        try {
          const buf = await core.read(asset.path, String(e.path), ctx.limits.maxImageBytes, { signal: ctx.signal });
          if (buf && buf.length) await save(buf, "png");
        } catch (err) {
          if (String((err as any)?.code ?? "") === "CANCELLED") throw new CancelledError();
          if (String((err as any)?.code ?? "") === "BYTES") { limited = { code: "BYTES", message: "单条目超过上限" }; break; }
          failed++;
        }
      }
    } else {
      return { skipped: "container has no extractable image frames" };
    }
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    throw e;
  }

  // 包里套包：外层没图时，下钻一层找 unitypackage 内 preview.png / 内层 zip 的图片（与 0.5.1 行为一致）
  if (saved === 0 && ["zip", "7z", "rar"].includes(String(asset.container))) {
    try { saved += await extractNested(ctx, asset, save); }
    catch (e) { if (e instanceof CancelledError) throw e; failed++; }
  }
  if (!saved && failed) return { limited: limited ?? { code: "UNSUPPORTED", message: "所有图片条目解码失败（" + failed + " 个）" } };
  return { itemsTotal: saved, note: "images+" + saved + (failed ? " failed=" + failed : ""), limited };
}

/** 阶段 D：深度元数据（结构/GUID/文件哈希三路指纹；失败不影响其它阶段）。 */
export async function stageMeta(ctx: StageCtx, asset: AssetRow): Promise<StageResult> {
  checkAbort(ctx.signal);
  const { computeSignature } = await import("../dedupe");
  const r: any = await computeSignature(ctx.repo, asset.id);
  ctx.repo.setAssetContentVersion(asset.id, fingerprintOf(asset));
  return { note: r ? "signature=" + String(r.structHash ?? "").slice(0, 8) : undefined };
}

/** 阶段 E：Avatar 匹配 + 自动分类建议（人工数据由 repo 层保护）。 */
export async function stageCategorize(ctx: StageCtx, asset: AssetRow): Promise<StageResult> {
  checkAbort(ctx.signal);
  const { matchItem } = await import("../match");
  const { applyCategoryEvidence } = await import("../categories");
  await matchItem(ctx.repo, asset.item_id, { fileNames: [basename(asset.path)] });
  applyCategoryEvidence(ctx.repo, asset.item_id, { log: ctx.log });
  checkAbort(ctx.signal);
  return { note: "matched+categorized" };
}

/** 阶段 F：FTS 同步（最后一步，保证搜索能看到前面的元数据）。 */
export async function stageFts(ctx: StageCtx, asset: AssetRow): Promise<StageResult> {
  checkAbort(ctx.signal);
  ctx.repo.syncFts(asset.item_id);
  return {};
}

export function stageFn(stage: Stage): (ctx: StageCtx, asset: AssetRow) => Promise<StageResult> {
  switch (stage) {
    case "hash": return stageHash;
    case "archive": return stageArchive;
    case "unitypackage": return stageUnityPackage;
    case "thumbs": return stageThumbs;
    case "meta": return stageMeta;
    case "categorize": return stageCategorize;
    case "fts": return stageFts;
  }
}


/** 一层嵌套包的缩略图抽取（默认上限 1 层）。临时文件只写系统临时目录，且必定清理。 */
async function extractNested(ctx: StageCtx, asset: AssetRow, save: (buf: Buffer, ext: string) => Promise<void>): Promise<number> {
  if (ctx.limits.maxNestedDepth < 1) return 0;
  const core = await coreArchive();
  const up = await coreUnityPackage();
  const entries = (ctx.repo.getArchiveEntries(asset.id) as any[])
    .filter((e) => !e.isDir && /\.(unitypackage|zip)$/i.test(String(e.path)))
    .filter((e) => Number(e.size) > 4096 && Number(e.size) <= ctx.limits.maxNestedBytes)
    .sort((a, b) => Number(b.size) - Number(a.size))
    .slice(0, 2);
  let saved = 0;
  for (const cand of entries) {
    checkAbort(ctx.signal);
    const tmp = join(tmpdir(), "av-nested-" + process.pid + "-" + Date.now() + "-" + basename(String(cand.path)).replace(/[^\w.\-]+/g, "_"));
    try {
      const buf = await core.read(asset.path, String(cand.path), ctx.limits.maxNestedBytes, { signal: ctx.signal });
      if (!buf?.length) continue;
      let pkgFile = tmp;
      if (/\.zip$/i.test(String(cand.path))) {
        writeFileSync(tmp, buf);
        const inner: any = await core.list(tmp, { maxEntries: 5000, signal: ctx.signal });
        const pkg = (inner.entries ?? []).find((e: any) => !e.isDir && /\.unitypackage$/i.test(String(e.path)) && Number(e.size) > 4096 && Number(e.size) <= ctx.limits.maxNestedBytes);
        if (!pkg) {
          const imgs = (inner.entries ?? [])
            .filter((e: any) => !e.isDir && IMAGE_EXT.test(String(e.path)) && Number(e.size) > 1024 && Number(e.size) <= ctx.limits.maxImageBytes)
            .sort((a: any, b: any) => Number(b.size) - Number(a.size)).slice(0, ctx.limits.maxThumbsPerAsset);
          for (const ie of imgs) {
            checkAbort(ctx.signal);
            const b2 = await core.read(tmp, String(ie.path), ctx.limits.maxImageBytes, { signal: ctx.signal });
            if (b2?.length) { await save(b2, "png"); saved++; }
          }
          if (saved > 0) return saved;
          continue;
        }
        pkgFile = tmp + ".unitypackage";
        writeFileSync(pkgFile, await core.read(tmp, String(pkg.path), ctx.limits.maxNestedBytes, { signal: ctx.signal }));
      } else {
        writeFileSync(tmp, buf);
      }
      const listing: any = await up.list(pkgFile, { maxAssets: ctx.limits.maxUnityPackageAssets, signal: ctx.signal });
      const previews = (listing.assets ?? []).filter((a: any) => a.hasPreview).slice(0, ctx.limits.maxThumbsPerAsset);
      for (const a of previews) {
        checkAbort(ctx.signal);
        const p = await up.preview(pkgFile, String(a.guid), { maxBytes: ctx.limits.maxImageBytes, signal: ctx.signal });
        if (p?.length) { await save(p, "png"); saved++; }
      }
      if (saved > 0) return saved;
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      if (String((e as any)?.code ?? "") === "CANCELLED") throw new CancelledError();
    } finally {
      for (const f of [tmp, tmp + ".unitypackage"]) { try { unlinkSync(f); } catch { /* ignore */ } }
    }
  }
  return saved;
}

/** 磁盘现状：身份校验与"解析期间文件有没有变"都靠它（只 stat，不读内容）。 */
function safeStat(p: string): LiveStat | null {
  try {
    const st = statSync(p);
    if (!st.isFile()) return null;
    return { size: st.size, mtimeMs: st.mtimeMs, ino: Number(st.ino), dev: Number(st.dev) };
  } catch { return null; }
}
