import { readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { normalizePath, extOf } from "../../../../packages/core/src/pathnorm";
import { identifyFromNames, extractItemIds } from "../../../../packages/core/src/identify";
import type { ContainerKind } from "../../../../packages/core/src/contracts";
import type { Repo } from "../db/repo";

const ARCHIVE_EXT = new Set([".zip", ".7z", ".rar", ".unitypackage"]);
const SKIP_DIR = new Set(["node_modules", ".git", "$RECYCLE.BIN", "System Volume Information", ".npm-cache", "dist"]);

export interface ScannedFile { path: string; size: number; mtime: string; container: ContainerKind; kind: "archive" | "unitypackage" | "loose_file" }

/** 单条读取失败记录（M0/P1：readdir/stat 的异常不再被静默吞掉）。 */
export interface ScanIssue { path: string; op: "readdir" | "stat"; code: string | null; message: string }

/** 一轮扫描的可读性统计：调用方据此判断"这棵树到底看全了没有"。 */
export interface ScanReadability {
  /** 根目录 readdir 是否成功；false ⇒ 连根都没读进来，结果不可用于判缺。 */
  rootReadable: boolean;
  /** readdir 成功的目录数（含根目录本身）。 */
  dirsRead: number;
  /** readdir 失败的目录数（权限 / IO / 竞态删除 / 未挂载）。 */
  dirsFailed: number;
  /** 目录项 statSync 失败的条目数（文件被删 / 被占用 / 权限）。 */
  entriesStatFailed: number;
}

export interface ScanStats {
  files: number; dirs: number; bytes: number; filesOut: ScannedFile[];
  /** 候选数触顶（limit）而提前收尾：本轮看到的**不是**整棵树。语义与旧版一致。 */
  truncated: boolean;
  // ---- M0/P1 向后兼容新增字段（旧字段语义未变，旧调用方忽略新字段即可）----
  /** 读取失败明细，最多 MAX_SCAN_ISSUES 条；errorCount 记真实总数。 */
  errors: ScanIssue[];
  /** 读取失败总条数（可能大于 errors.length）。 */
  errorCount: number;
  readability: ScanReadability;
  /** 本轮是否"完整可信"：未截断 + 无读取错误 + 根目录可读。false ⇒ 不得据此批量判缺。 */
  complete: boolean;
  /** 调用方传入的扫描清单（原样回传，便于消费方在同一对象上断言/判缺）；未传则 undefined。 */
  manifest?: ScanManifest;
}

/**
 * 扫描清单：把"本轮见过哪些 path_norm"从内存数组/Set 里搬出去（v0.6.1-A）。
 *
 * 语义契约（消费方实现/使用时必须遵守）：
 *  - 记录的是**已提交批次的候选**：onBatch 模式下在批边界写入；中止时未提交批次里的条目**不写**
 *    （那批没有被消费方接受，重放会重新看到它们）。
 *  - 判缺 = 库内 present 资产 − 清单（等价于旧实现的 seen Set）；missingWriteGate 仍然照旧把关。
 *  - path_norm 由 walk 内部归一化后再写入（调用方不必自己 normalize）。
 *  - 默认实现是内存 Set（createMemoryManifest，2 万条约 4.2MB）；生产建议换 SQLite TEMP 表实现（免迁移）。
 */
export interface ScanManifest {
  /** 记录一条（幂等）。 */
  add(pathNorm: string): void;
  /** 批量记录（批边界调用一次；实现可一次 INSERT 多行）。 */
  addMany(pathNorms: string[]): void;
  /** 已记录条数（诊断用，必须与实际写入行数一致）。 */
  readonly size: number;
  /** 是否已记录（消费方断言/自测用；TEMP 表实现用 SELECT 1）。 */
  has(pathNorm: string): boolean;
  /** 本轮收尾（可选）：完整且未截断时调用，供落盘清单刷盘/提交。 */
  finish?(stats: { files: number; truncated: boolean; complete: boolean }): void;
}

/** 默认清单实现：内存 Set。只适合调用方明确接受该内存成本时使用。 */
export function createMemoryManifest(): ScanManifest {
  const set = new Set<string>();
  return {
    add(pathNorm: string): void { if (pathNorm) set.add(pathNorm); },
    addMany(pathNorms: string[]): void { for (const p of pathNorms) if (p) set.add(p); },
    get size(): number { return set.size; },
    has(pathNorm: string): boolean { return set.has(pathNorm); },
  };
}

/**
 * 单批回调看到的累计计数（不是本批增量）与批次标识。
 * batch 从 1 起；batchFiles 是本批条数（= files[n] - files[n-1]），便于消费方做幂等键与诊断。
 */
export interface WalkBatchStats {
  files: number; dirs: number; bytes: number; truncated: boolean;
  /** 第几批（1 起）。 */
  batch: number;
  /** 本批条数。 */
  batchFiles: number;
}

/**
 * v0.6.0 阶段 A：有界批次/流式遍历参数（向后兼容：不传 onBatch 时行为与旧版完全一致）。
 *  - batchSize   每批最多多少条 ScannedFile（默认 500）
 *  - onBatch     逐批回调（可以是 async）；**传入时 filesOut 恒为空数组**以省内存
 *  - signal      每批开始 + 每 256 个目录项检查一次；已中止 → 抛 code="CANCELLED"
 *
 * v0.6.1-A 新增：
 *  - manifest    扫描清单（可选）。传入时逐批写入 path_norm，消费方不必再保留全量 filesOut 去算 seen；
 *                只在候选入批时写，不改变 filesOut / truncated / errors 任何既有语义。
 */
export interface WalkOptions {
  maxDepth?: number;
  limit?: number;
  signal?: AbortSignal;
  batchSize?: number;
  onBatch?: (files: ScannedFile[], stats: WalkBatchStats) => Promise<void> | void;
  manifest?: ScanManifest;
}

/**
 * 背压闸门（v0.6.1-A）：在批次边界检查下游队列深度，超 highWater 时等待，降到 lowWater 以下继续。
 * 纯函数式（depth/sleep 都可注入），不依赖 DB，便于单测；由消费方在每批开始时 await gate.wait()。
 *
 * 语义：
 *  - depth() <= highWater             → 立即放行 { waited:false, throttled:false }
 *  - depth() >  highWater             → 每 pollMs 重新探一次，直到 depth() <= lowWater
 *  - 等待超过 maxWaitMs               → 放行但 throttled=true（调用方决定记事件/继续；绝不静默卡死）
 *  - signal 中止                      → 抛 code="CANCELLED"（与 walk 的取消语义一致）
 */
export interface BackpressureGateOptions {
  /** 读取下游积压深度（如 index_tasks 的 queued 计数）；可 async。 */
  depth: () => number | Promise<number>;
  /** 超过它就开始等。 */
  highWater: number;
  /** 降到它（含）以下才继续。 */
  lowWater: number;
  signal?: AbortSignal;
  /** 轮询间隔（默认 200ms）。 */
  pollMs?: number;
  /** 最长等待（默认 30000ms）；0 = 不限制。 */
  maxWaitMs?: number;
  /** 注入 sleep（测试用虚拟时钟）。 */
  sleep?: (ms: number) => Promise<void>;
}

export interface BackpressureGateResult { waited: boolean; waitedMs: number; throttled: boolean; depth: number }

export interface BackpressureGate {
  wait(): Promise<BackpressureGateResult>;
}

export function createBackpressureGate(opts: BackpressureGateOptions): BackpressureGate {
  const pollMs = Math.max(1, Math.floor(opts.pollMs ?? 200));
  const maxWaitMs = Math.max(0, Math.floor(opts.maxWaitMs ?? 30000));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    async wait(): Promise<BackpressureGateResult> {
      if (opts.signal?.aborted) throw walkCancelledError();
      let d = Number(await opts.depth());
      if (!Number.isFinite(d)) d = 0;
      if (d <= opts.highWater) return { waited: false, waitedMs: 0, throttled: false, depth: d };
      let waitedMs = 0;
      for (;;) {
        if (opts.signal?.aborted) throw walkCancelledError();
        if (maxWaitMs > 0 && waitedMs >= maxWaitMs) return { waited: true, waitedMs, throttled: true, depth: d };
        await sleep(pollMs);
        waitedMs += pollMs;
        if (opts.signal?.aborted) throw walkCancelledError();
        d = Number(await opts.depth());
        if (!Number.isFinite(d)) d = 0;
        if (d <= opts.lowWater) return { waited: true, waitedMs, throttled: false, depth: d };
      }
    },
  };
}

/** errors 明细保留上限（坏盘/大目录不至于撑爆内存与日志）；errorCount 仍记真值。 */
const MAX_SCAN_ISSUES = 100;
/** 流式模式默认批大小。 */
const DEFAULT_BATCH_SIZE = 500;
/** 非候选目录项的中途让出频率（防"整棵树几乎没有压缩包"时长时间不给事件循环）。 */
const ENTRY_YIELD_EVERY = 2000;
/** AbortSignal 检查频率（目录项）。 */
const ABORT_CHECK_EVERY = 256;

const errCode = (e: unknown): string | null => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : null;
};

/** 取消错误：统一 code="CANCELLED"（调用方据此区分"被取消"与"读失败"）。 */
export function walkCancelledError(): Error {
  return Object.assign(new Error("walk cancelled by AbortSignal"), { code: "CANCELLED" });
}

/**
 * 缺文件判定门控（M0/P1）：只有"完整可信"的一轮扫描才允许把本轮未见的资产批量标 missing。
 * 触发任一条件即拒绝写入（reasons 里给出原因，供 job event / 日志取证）：
 *   - truncated          候选数触顶，本轮只看到一部分；
 *   - errorCount > 0     有目录/文件读取失败，"未见"可能只是"没读到"；
 *   - !rootReadable      根目录 readdir 失败（路径不存在/不可访问/未挂载）；
 *   - dirsRead === 0     空树保护：一个目录都没枚举成功，没有任何"这棵子树是空的"的证据。
 * 已知正/反例对照（纪律 #6）：
 *   正例（allowed=true）：目录可读、扫到 1 个 zip、0 错误 0 截断；以及 AC7 的"文件真的被删掉"场景
 *     （目录仍可读 dirsRead=1、files=0、0 错误）——这是"文件没了"的完整证据，必须仍能翻 missing。
 *   反例（allowed=false）：同一目录读不了（rootReadable=false, dirsRead=0）→ 拒绝；
 *     候选数触顶（truncated=true）→ 拒绝；子目录 EACCES（errorCount>0）→ 拒绝。
 */
export function missingWriteGate(s: Pick<ScanStats, "truncated" | "errorCount" | "readability">): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (s.truncated) reasons.push("truncated");
  if (s.errorCount > 0) reasons.push("read_errors:" + s.errorCount);
  if (!s.readability.rootReadable) reasons.push("root_unreadable");
  if (s.readability.dirsRead === 0) reasons.push("empty_tree_no_readdir");
  return { allowed: reasons.length === 0, reasons };
}

/**
 * 有界目录扫描：默认深 6、上限 20000 个候选项，超出置 truncated。
 *
 * v0.6.0 阶段 A 改造：
 *  - **显式栈（非递归）**：不再用 await walk(dir, depth+1) 自递归，深目录不会爆栈；遍历顺序仍是
 *    DFS 前序 + readdirSync 的原始顺序（与旧递归实现逐条一致，见 test/scan/walk.test.ts 的顺序对照）。
 *  - **有界批次**：传 onBatch 时每 batchSize 条回调一次并 filesOut=[]，调用方不必把全量路径堆在内存里；
 *    每批之间 setImmediate 让出事件循环。
 *  - **可取消**：传 signal；每批开始 + 每 256 个目录项检查，已中止抛 code="CANCELLED"。
 *  - SKIP_DIR / maxDepth / limit / errors / readability / complete 语义**未变**（冻结契约）。
 *
 * 语义细节（与旧版一一对应，测试钉死）：
 *  - dirs 只统计"作为目录项被看到的目录"（不含根本身；深度越界的目录仍计入但不再下沉）；
 *  - files/bytes 只统计候选压缩包；limit 只压制候选数；
 *  - 顺序 = 每个目录项按 readdir 顺序处理，遇到子目录立刻整棵子树（DFS 前序）。
 */
export async function walkCandidates(rootPath: string, opts: WalkOptions = {}): Promise<ScanStats> {
  if (!existsSync(rootPath)) throw Object.assign(new Error("路径不存在: " + rootPath), { code: "NOT_FOUND", status: 404 });
  const maxDepth = opts.maxDepth ?? 6;
  const limit = opts.limit ?? 20000;
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE));
  const signal = opts.signal;
  const streaming = typeof opts.onBatch === "function";
  const out: ScannedFile[] = [];
  const errors: ScanIssue[] = [];
  const readability: ScanReadability = { rootReadable: false, dirsRead: 0, dirsFailed: 0, entriesStatFailed: 0 };
  let files = 0, dirs = 0, bytes = 0, truncated = false, sinceYield = 0, errorCount = 0;
  /** 已提交批次数（1 起递增，供 WalkBatchStats.batch 使用）。 */
  let batchNo = 0;
  const noteError = (path: string, op: ScanIssue["op"], e: unknown): void => {
    errorCount++;
    if (errors.length < MAX_SCAN_ISSUES) errors.push({ path, op, code: errCode(e), message: String((e as Error | null)?.message ?? e) });
  };
  let batch: ScannedFile[] = [];
  /** 清单待写缓冲：只在"批已提交"（onBatch 成功返回）后落账，中止/抛错的批次不记。 */
  let manifestPending: string[] = [];
  const flushManifest = (): void => {
    if (!opts.manifest || manifestPending.length === 0) return;
    const b = manifestPending;
    manifestPending = [];
    opts.manifest.addMany(b);
  };
  const flushBatch = async (): Promise<void> => {
    if (!streaming || batch.length === 0) return;
    const b = batch;
    batch = [];
    await opts.onBatch!(b, { files, dirs, bytes, truncated, batch: batchNo + 1, batchFiles: b.length });
    batchNo++;
    flushManifest(); // 批提交成功后才记清单（中止/失败批次不记）
    await new Promise<void>((r) => setImmediate(r));
  };
  const makeStats = (): ScanStats => ({
    files, dirs, bytes,
    filesOut: streaming ? [] : out,
    truncated, errors, errorCount, readability,
    complete: !truncated && errorCount === 0 && readability.rootReadable,
    manifest: opts.manifest,
  });

  // 根不是目录：等价于旧版 readdirSync 抛 ENOTDIR（记 readdir 错误后返回，绝不静默当成空树）。
  let rootIsDir = true;
  try { rootIsDir = statSync(rootPath).isDirectory(); } catch { /* 让下面的逻辑按目录处理，readdir 会报错 */ }
  if (!rootIsDir) {
    readability.dirsFailed++;
    noteError(rootPath, "readdir", Object.assign(new Error("ENOTDIR: not a directory: " + rootPath), { code: "ENOTDIR" }));
    return makeStats();
  }

  // 显式栈：存"待检查的条目"（文件或目录），弹出顺序即 DFS 前序。
  const stack: { path: string; depth: number }[] = [{ path: rootPath, depth: 0 }];
  let entriesSinceCheck = 0;
  while (stack.length > 0 && !truncated) {
    if (signal?.aborted) throw walkCancelledError();
    const item = stack.pop()!;
    let st;
    try { st = statSync(item.path); }
    catch (e) { readability.entriesStatFailed++; noteError(item.path, "stat", e); continue; }
    if (st.isDirectory()) {
      if (item.depth > 0) dirs++;              // 根本身不计入 dirs（与旧版一致）
      if (item.depth > maxDepth) continue;     // 越界目录：计数但不下沉
      let entries: string[];
      try { entries = readdirSync(item.path); }
      catch (e) { readability.dirsFailed++; noteError(item.path, "readdir", e); continue; }
      readability.dirsRead++;
      if (item.depth === 0) readability.rootReadable = true;
      // 逆序入栈 → 弹出顺序与 readdir 顺序一致
      for (let i = entries.length - 1; i >= 0; i--) {
        const name = entries[i];
        if (SKIP_DIR.has(name)) continue;
        stack.push({ path: join(item.path, name), depth: item.depth + 1 });
      }
      continue;
    }
    const ext = extname(item.path).toLowerCase();
    if (!ARCHIVE_EXT.has(ext)) {
      if (++entriesSinceCheck >= ENTRY_YIELD_EVERY) { entriesSinceCheck = 0; await new Promise<void>((r) => setImmediate(r)); }
      continue;
    }
    if (files >= limit) { truncated = true; break; }
    const sf: ScannedFile = {
      path: item.path, size: st.size, mtime: st.mtime.toISOString(),
      container: ext.slice(1) as ContainerKind,
      kind: ext === ".unitypackage" ? "unitypackage" : "archive",
    };
    files++; bytes += st.size;
    if (opts.manifest) manifestPending.push(normalizePath(item.path));
    if (streaming) {
      batch.push(sf);
      if (batch.length >= batchSize) await flushBatch();
    } else {
      out.push(sf);
      // 非流式模式没有"批提交"概念：每凑够一批就落账，避免清单缓冲本身变成无界数组
      if (manifestPending.length >= batchSize) flushManifest();
      if (++sinceYield >= 200) { sinceYield = 0; await new Promise<void>((r) => setImmediate(r)); }
    }
    if (++entriesSinceCheck >= ABORT_CHECK_EVERY) {
      entriesSinceCheck = 0;
      if (signal?.aborted) throw walkCancelledError();
    }
  }
  // 收尾：把不足一批的尾巴交出去（中止优先，不把"取消前的一瞬"当成功）
  if (signal?.aborted) throw walkCancelledError();
  await flushBatch();
  flushManifest();
  const stats = makeStats();
  // 只有"完整可信"的一轮才通知清单收尾（落盘清单可据此刷盘/提交；不完整的一轮不得当作判缺依据）
  if (opts.manifest && stats.complete && typeof opts.manifest.finish === "function") {
    opts.manifest.finish({ files: stats.files, truncated: stats.truncated, complete: stats.complete });
  }
  return stats;
}

export interface ScanPlanItem {
  title: string; sourceSite: "booth" | "local"; sourceItemId: string | null; confidence: number; method: string | null;
  evidence: string[]; assets: { file: ScannedFile }[];
}

/** 单路径 → ScannedFile（apply 阶段按显式文件列表重建 filesOut 时用；stat 失败返回 null）。 */
export function scannedFileOf(p: string): ScannedFile | null {
  try {
    const st = statSync(p);
    if (!st.isFile()) return null;
    const ext = extname(p).toLowerCase();
    const container: ContainerKind = ext === ".unitypackage" ? "unitypackage"
      : ext === ".zip" ? "zip" : ext === ".7z" ? "7z" : ext === ".rar" ? "rar" : "file";
    const kind: ScannedFile["kind"] = ext === ".unitypackage" ? "unitypackage"
      : (ext === ".zip" || ext === ".7z" || ext === ".rar") ? "archive" : "loose_file";
    return { path: p, size: st.size, mtime: st.mtime.toISOString(), container, kind };
  } catch { return null; }
}

/** 把扫到的文件按"同目录/同 itemId"归组，产出建条目计划（不落库，便于测试）。 */
export function planFromFiles(rootPath: string, files: ScannedFile[]): ScanPlanItem[] {
  const groups = new Map<string, ScanPlanItem>();
  const rootPrefix = rootPath.replace(/[\\/]+$/, "");
  for (const f of files) {
    const rel = f.path.startsWith(rootPrefix) ? f.path.slice(rootPrefix.length).replace(/^[\\/]+/, "") : f.path;
    const parts = rel.split(/[\\/]+/).filter(Boolean);
    const fileName = parts.pop() ?? f.path;
    const ancestors = parts; // 相对扫描根的上层目录名（商品号可能在任意一层）
    const id = identifyFromNames([fileName, ...ancestors], []);
    const best = id.best;
    // 有商品号 → 按商品号归并；无商品号 → 一个压缩包一个条目（不再把整个目录当一个商品）
    const key = best ? "booth:" + best.itemId : "local:" + normalizePath(f.path);
    let g = groups.get(key);
    if (!g) {
      const idDir = best ? ancestors.find((p) => p.includes(best.itemId)) : undefined;
      const title = (idDir ?? fileName).replace(/\.[^.]+$/, "").trim() || fileName;
      g = {
        title,
        sourceSite: best ? "booth" : "local",
        sourceItemId: best?.itemId ?? null,
        confidence: best?.confidence ?? 0,
        method: best?.method ?? null,
        evidence: best?.evidence ?? [],
        assets: [],
      };
      groups.set(key, g);
    }
    g.assets.push({ file: f });
  }
  return [...groups.values()];
}

/**
 * 把文件登记为资产（path_norm 去重）。
 * changed = 已存在且 size/mtime 变了 —— 扫描应用必须把这类资产重新入队深度索引，
 * 否则"已变化的文件"只更新了 size/mtime，包内目录与缩略图仍是旧快照（v0.6.0 修复）。
 */
export function registerAssets(repo: Repo, rootId: number, path: string, itemId: number, f: ScannedFile, discoveredBy: "scan" | "watch" | "download" | "manual"): { id: number; created: boolean; changed: boolean } {
  const pn = normalizePath(f.path);
  const before = repo.getAssetByPathNorm(pn);
  const changed = !!before && (Number(before.size) !== Number(f.size) || String(before.mtime ?? "") !== String(f.mtime ?? ""));
  const r = repo.upsertAsset({
    item_id: itemId, kind: f.kind, container: f.container, path: f.path,
    path_norm: pn, root_id: rootId, size: f.size, mtime: f.mtime, discovered_by: discoveredBy,
  });
  void extOf; void extractItemIds; void path; void basename;
  if (changed) { try { repo.setAssetIndexState(r.asset.id, "pending", null); } catch { /* ignore */ } }
  return { id: r.asset.id, created: r.created, changed };
}
