/**
 * 流水线资源限制（v0.6.0）
 *
 * 设计原则：
 *  - 默认值保守，全部可在 settings.pipeline_limits（JSON）里覆盖；读取时逐项 clamp，拒绝负数/NaN。
 *  - 限制参与缓存键（limitsHash）：改了单包条目上限，旧的目录缓存就不能再冒充"同一结果"。
 *  - 不引入自动调参：先给安全默认值 + 可观测数据，由人决定调不调。
 */
import { createHash } from "node:crypto";

export interface PipelineLimits {
  // ---- 并发（按任务类型分别限流，不拿 CPU 核数当万能并发）----
  hashConcurrency: number;
  archiveConcurrency: number;
  unityPackageConcurrency: number;
  thumbConcurrency: number;
  metaConcurrency: number;
  categorizeConcurrency: number;
  ftsConcurrency: number;
  /** 扫描发现：每批写库/入队的资产数（同时是事务大小上限） */
  registerBatchSize: number;
  /** 发现阶段单轮最多候选数（现有语义上限） */
  maxScanFiles: number;
  scanMaxDepth: number;
  scanDeepMaxDepth: number;

  // ---- 单文件 / 单包 ----
  /** 哈希读块大小（字节） */
  hashChunkBytes: number;
  /** 超过这个大小就不做全文件哈希，标 limited（0 = 不限制） */
  maxHashBytes: number;
  /** 超过这个大小不做深度解析，标 limited（0 = 不限制） */
  maxArchiveBytes: number;
  /** 单个归档最多列出的条目数 */
  maxArchiveEntries: number;
  /** 单条目最大读取字节（抽缩略图/预览文本） */
  maxEntryBytes: number;
  /** 最大累计读取字节（单资产） */
  maxTotalReadBytes: number;
  /** 嵌套包最大层数（现有能力是 1 层，默认保持） */
  maxNestedDepth: number;
  /** 嵌套包最大字节 */
  maxNestedBytes: number;
  /** unitypackage 最多解析的资产条目数 */
  maxUnityPackageAssets: number;
  /** 压缩比上限（解压后/压缩前）；超过视为可疑高压缩比，拒绝解压 */
  maxCompressionRatio: number;

  // ---- 图片 ----
  maxImageBytes: number;
  maxImagePixels: number;
  thumbMaxSize: number;
  /** 每个资产最多抽几张缩略图 */
  maxThumbsPerAsset: number;

  // ---- 时间 / 重试 ----
  hashTimeoutMs: number;
  archiveTimeoutMs: number;
  thumbTimeoutMs: number;
  taskMaxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;

  // ---- 队列 / 背压 ----
  queueHighWater: number;
  queueLowWater: number;
  progressFlushMs: number;

  // ---- 缓存 ----
  cacheMaxBytes: number;
  cacheMaxAgeDays: number;
  /** 缓存清理保留的最近使用条目数（避免把正在用的清掉） */
  cacheKeepEntries: number;
}

/** 安全默认值：面向"几万个小文件 + 偶尔 1GB 压缩包"的本地库。 */
export const DEFAULT_LIMITS: Readonly<PipelineLimits> = Object.freeze({
  hashConcurrency: 2,
  archiveConcurrency: 1,
  unityPackageConcurrency: 1,
  thumbConcurrency: 2,
  metaConcurrency: 1,
  categorizeConcurrency: 1,
  ftsConcurrency: 1,
  registerBatchSize: 200,
  maxScanFiles: 20000,
  scanMaxDepth: 6,
  scanDeepMaxDepth: 10,

  hashChunkBytes: 1 << 20,
  maxHashBytes: 8 * 1024 * 1024 * 1024,
  maxArchiveBytes: 4 * 1024 * 1024 * 1024,
  maxArchiveEntries: 20000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalReadBytes: 512 * 1024 * 1024,
  maxNestedDepth: 1,
  maxNestedBytes: 256 * 1024 * 1024,
  maxUnityPackageAssets: 20000,
  maxCompressionRatio: 200,

  maxImageBytes: 12 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  thumbMaxSize: 512,
  maxThumbsPerAsset: 8,

  hashTimeoutMs: 10 * 60 * 1000,
  archiveTimeoutMs: 10 * 60 * 1000,
  thumbTimeoutMs: 2 * 60 * 1000,
  taskMaxAttempts: 3,
  retryBaseMs: 1000,
  retryMaxMs: 60_000,

  queueHighWater: 2000,
  queueLowWater: 500,
  progressFlushMs: 400,

  cacheMaxBytes: 2 * 1024 * 1024 * 1024,
  cacheMaxAgeDays: 30,
  cacheKeepEntries: 100,
});

type NumericKey = { [K in keyof PipelineLimits]: PipelineLimits[K] extends number ? K : never }[keyof PipelineLimits];
const MIN: Partial<Record<keyof PipelineLimits, number>> = { taskMaxAttempts: 1, maxNestedDepth: 0, maxCompressionRatio: 1 };
const MAX: Partial<Record<keyof PipelineLimits, number>> = { taskMaxAttempts: 10, maxNestedDepth: 8, queueHighWater: 1_000_000 };

/** 把任意 JSON 合并进默认值；未知键忽略，非数字/越界 clamp，绝不因配置写坏而崩。 */
export function resolveLimits(raw: unknown): PipelineLimits {
  const out: PipelineLimits = { ...DEFAULT_LIMITS };
  if (!raw || typeof raw !== "object") return out;
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof PipelineLimits)[]) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const min = MIN[key as NumericKey] ?? 1;
    const max = MAX[key as NumericKey] ?? Number.MAX_SAFE_INTEGER;
    (out as any)[key] = Math.min(max, Math.max(min, Math.floor(v)));
  }
  return out;
}

/** 限制指纹：缓存键的一部分（改限制 ⇒ 旧缓存自动失效，不需要手工清）。 */
export function limitsHash(l: PipelineLimits): string {
  const canonical = JSON.stringify(l, Object.keys(l).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** 诊断用：哪些限制是"非默认"的（面板上高亮，避免悄悄跑在异常配置上）。 */
export function nonDefaultLimits(l: PipelineLimits): Partial<PipelineLimits> {
  const out: Partial<PipelineLimits> = {};
  for (const k of Object.keys(DEFAULT_LIMITS) as (keyof PipelineLimits)[]) {
    if (l[k] !== DEFAULT_LIMITS[k]) (out as any)[k] = l[k];
  }
  return out;
}
