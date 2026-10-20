/**
 * 单资产索引（同步入口，v0.6.0 起与流水线共用同一套阶段实现）
 *
 * 用途：
 *  - 用户点「重新索引」/ POST /api/assets/:id/reindex（单条、可接受同步等待）；
 *  - 没有启用流水线的嵌入式实例（listen:false / 未取得单写入者锁）作为回退路径；
 *  - 单元测试与诊断脚本。
 *
 * 扫描 / 导入 / 应用 走 IndexPipeline（后台、有界并发、可取消），不调用这里。
 * 两边共用 stage* 实现，避免"两条索引路径行为不一致"。
 */
import type { AssetRow } from "../../../../packages/core/src/contracts";
import type { Repo } from "../db/repo";
import type { MediaStore } from "./media";
import type { CacheLike, CacheMeta } from "./pipeline/cache";
import { DEFAULT_LIMITS, type PipelineLimits } from "./pipeline/limits";
import { stageArchive, stageHash, stageMeta, stageThumbs, stageUnityPackage, type StageCtx } from "./pipeline/stages";

export interface IndexResult { container: string; entries: number; unityAssets: number; images: number; hashed: boolean; note?: string }

export interface IndexOptions {
  /** 兼容旧调用：超过这个大小不哈希（覆盖 limits.maxHashBytes） */
  hashMaxBytes?: number;
  limits?: Partial<PipelineLimits>;
  cache?: CacheLike;
  signal?: AbortSignal;
  log?: (m: string) => void;
}

/** 单次索引用的内存缓存（不落盘；缓存系统只服务后台流水线）。 */
class MemoryCache implements CacheLike {
  private map = new Map<string, unknown>();
  async get<T>(_kind: string, key: string): Promise<T | null> { return (this.map.get(key) as T) ?? null; }
  async put(_kind: string, key: string, value: unknown, _meta: CacheMeta): Promise<{ bytes: number }> { this.map.set(key, value); return { bytes: 0 }; }
}

/** 列目录 / 解析 unitypackage / 抽取缩略图 / 哈希 / 结构签名。不启动 Unity，不搬动素材本体。 */
export async function indexAsset(repo: Repo, media: MediaStore, assetId: number, opts: IndexOptions = {}): Promise<IndexResult> {
  const asset = repo.getAsset(assetId) as AssetRow | null;
  if (!asset) throw new Error(`asset ${assetId} not found`);
  const limits: PipelineLimits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  if (opts.hashMaxBytes !== undefined) limits.maxHashBytes = Math.max(0, opts.hashMaxBytes);
  const ctx: StageCtx = {
    repo, media, limits,
    cache: opts.cache ?? new MemoryCache(),
    log: opts.log ?? (() => {}),
    signal: opts.signal ?? new AbortController().signal,
    progress: () => {},
  };
  const res: IndexResult = { container: asset.container, entries: 0, unityAssets: 0, images: 0, hashed: false };
  const notes: string[] = [];

  if (asset.container === "unitypackage") {
    const r = await stageUnityPackage(ctx, asset);
    res.unityAssets = r.itemsTotal ?? 0;
    if (r.limited) notes.push(r.limited.code + ":" + r.limited.message);
  } else if (asset.container === "zip" || asset.container === "7z" || asset.container === "rar") {
    const r = await stageArchive(ctx, asset);
    res.entries = r.itemsTotal ?? 0;
    if (r.limited) notes.push(r.limited.code + ":" + r.limited.message);
  }

  if (asset.container === "unitypackage" || res.entries > 0) {
    try {
      const t = await stageThumbs(ctx, asset);
      res.images = t.itemsTotal ?? 0;
      if (t.limited) notes.push(t.limited.code + ":" + t.limited.message);
      if (t.note) notes.push(t.note);
    } catch (e) {
      notes.push("thumbs failed: " + String((e as Error)?.message ?? e));
    }
  }

  try {
    const h = await stageHash(ctx, asset);
    res.hashed = !h.limited && !h.skipped;
    if (h.limited) notes.push(h.limited.code + ":" + h.limited.message);
  } catch (e) {
    repo.setAssetSha(assetId, null, "error");
    notes.push("hash failed: " + String((e as Error)?.message ?? e));
  }

  try { await stageMeta(ctx, asset); } catch { /* 签名失败不影响索引结果 */ }
  repo.touchAsset(assetId);
  res.note = notes.length ? notes.join("; ") : undefined;
  return res;
}
