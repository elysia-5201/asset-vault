/**
 * 后台索引流水线（v0.6.0）
 *
 * 目标：把"建档"与"深度解析"解耦。
 *   - scan/apply 作业只做发现 + 基础登记 + 入队，随后立即完成 → 小文件不被大包阻塞；
 *   - 每个资产的 hash / archive / unitypackage / thumbs / meta / categorize / fts 是独立子任务；
 *   - 每类任务独立并发上限；队列有高/低水位背压；
 *   - 任务可取消、可重试、崩溃后可恢复；进度按阶段落库（节流），不伪造百分比。
 *
 * 不新增第二套状态机：jobs 仍是顶层作业；index_tasks 是它派生的子任务队列，
 * 状态语义固定为 queued / running / done / skipped / waiting_retry / failed / cancelled。
 */
import type { AssetRow } from "../../../../../packages/core/src/contracts";
import type { Repo } from "../../db/repo";
import type { MediaStore } from "../media";
import { DerivedCache } from "./cache";
import type { PipelineLimits } from "./limits";
import { checkAbort, CancelledError, fingerprintOf, stageFn, STAGE_ORDER, type Stage, type StageCtx, type StageResult } from "./stages";

export interface PipelineDeps {
  repo: Repo;
  media: MediaStore;
  cache: DerivedCache;
  limits: PipelineLimits;
  log: (m: string) => void;
}

export interface EnqueueOptions {
  /** 50=新入库；100=用户正在看（交互式）；10=历史重建 */
  priority?: number;
  /** 只入队某个阶段（内部用） */
  stagesOnly?: Stage[];
}

export interface PipelineStats {
  started: boolean;
  paused: boolean;
  startedAt: string;
  running: number;
  queued: number;
  waitingRetry: number;
  failed: number;
  done: number;
  cancelled: number;
  skipped: number;
  stages: { stage: Stage; queued: number; running: number; waitingRetry: number; failed: number; done: number; skipped: number; avgMs: number | null }[];
  cache: ReturnType<DerivedCache["stats"]>;
  memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
  processed: number;
  failures: number;
  lastError: { at: string; stage: string; assetId: number; message: string } | null;
}

interface ProgressPatch { bytesDone?: number; bytesTotal?: number; itemsDone?: number; itemsTotal?: number }

export class IndexPipeline {
  private stopped = false;
  private started = false;
  private paused = false;
  private startedAt = new Date().toISOString();
  private workers: Promise<void>[] = [];
  private controllers = new Map<number, AbortController>();
  private progress = new Map<number, ProgressPatch>();
  private flushTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private sleepers = new Set<() => void>();
  private processed = 0;
  private failures = 0;
  private lastError: PipelineStats["lastError"] = null;
  private stageMetrics = new Map<Stage, { count: number; ms: number }>();

  constructor(private readonly deps: PipelineDeps) {}

  // ---------- 生命周期 ----------
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    const recovered = this.deps.repo.recoverIndexTasks();
    const temp = this.deps.cache.pruneTemp();
    if (recovered) this.deps.log("pipeline: recovered " + recovered + " task(s) into queued");
    if (temp) this.deps.log("pipeline: pruned " + temp + " temp cache file(s)");
    for (const stage of STAGE_ORDER) {
      const n = this.concurrencyOf(stage);
      for (let i = 0; i < n; i++) this.workers.push(this.loop(stage));
    }
    this.flushTimer = setInterval(() => this.flushProgress(), this.deps.limits.progressFlushMs);
    this.flushTimer.unref?.();
    // 退避到期的 waiting_retry 必须被提升回 queued，否则运行期永远不会重试（verifier BUG-1）
    this.retryTimer = setInterval(() => {
      try {
        if (this.deps.repo.promoteDueRetries() > 0) this.notify();
      } catch { /* 下一轮再试 */ }
    }, 1000);
    this.retryTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const ac of this.controllers.values()) ac.abort("shutdown");
    this.controllers.clear();
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
    this.notify();
    await Promise.allSettled(this.workers);
    this.workers = [];
    this.started = false;
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; this.notify(); }

  /** 等待队列清空（测试/验收用）。返回 false = 超时。 */
  async drain(timeoutMs = 120_000, pollMs = 25): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { this.deps.repo.promoteDueRetries(); } catch { /* ignore */ }
      const counts = this.countsByState();
      if ((counts.queued ?? 0) === 0 && (counts.running ?? 0) === 0 && (counts.waiting_retry ?? 0) === 0) {
        this.flushProgress();
        return true;
      }
      this.notify();
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  }

  // ---------- 入队 ----------
  /** 为一个资产建立完整阶段链（幂等：已有活跃任务会复用）。返回任务 id 列表。 */
  enqueueAsset(assetId: number, opts: EnqueueOptions = {}): number[] {
    const asset = this.deps.repo.getAsset(assetId);
    if (!asset || asset.status === "trashed") return [];
    const priority = opts.priority ?? 50;
    const fp = fingerprintOf(asset);
    const ids: number[] = [];
    const enqueue = (stage: Stage, dependsOn: number | null): number => {
      const id = this.deps.repo.enqueueIndexTask({
        assetId: asset.id, itemId: asset.item_id, stage, priority,
        maxAttempts: this.deps.limits.taskMaxAttempts,
        dependsOn, fingerprint: fp,
        versionKey: "v1",
      });
      ids.push(id);
      return id;
    };

    const chain: Stage[] = [];
    if (asset.container === "unitypackage") chain.push("unitypackage", "thumbs");
    else if (asset.container === "zip" || asset.container === "7z" || asset.container === "rar") chain.push("archive", "thumbs");
    else chain.push("hash");
    chain.push("meta", "categorize", "fts");

    // 哈希独立于解包（大包哈希与目录解析可以并行，但各自有独立并发上限）
    if (chain[0] !== "hash") enqueue("hash", null);
    let dep: number | null = null;
    for (const stage of chain) dep = enqueue(stage, dep);
    this.deps.repo.setAssetIndexState(asset.id, "queued", null);
    this.notify();
    return ids;
  }

  /** 全库/筛选后重建（诊断面板与 CLI 用）。返回入队资产数。 */
  enqueueMany(assetIds: number[], opts: EnqueueOptions = {}): number {
    let n = 0;
    for (const id of assetIds) { if (this.enqueueAsset(id, opts).length) n++; }
    return n;
  }

  /** 有界等待：这些资产的流水线任务全部结束后返回 true；超时返回 false（作业不因此失败）。 */
  async drainAssets(assetIds: number[], timeoutMs = 8000, pollMs = 50): Promise<boolean> {
    const ids = [...new Set(assetIds)];
    if (!ids.length) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (this.deps.repo.countActiveIndexTasks(ids) === 0) { this.flushProgress(); return true; } }
      catch { return false; }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  }

  /** 交互式提升：用户打开的包优先解析。 */
  boost(assetId: number, priority = 100): number {
    const n = this.deps.repo.boostIndexTasks(assetId, priority);
    if (n) this.notify();
    return n;
  }

  /** 取消一个资产的全部活跃任务；运行中的用 AbortController 协作取消。 */
  cancelAsset(assetId: number): number {
    let n = 0;
    for (const [taskId, ac] of this.controllers) {
      const t = this.deps.repo.getIndexTask(taskId);
      if (t && Number(t.asset_id) === assetId) { ac.abort("cancelled"); n++; }
    }
    // 清掉依赖链里后续排队的任务（避免上游取消后下游空转）
    n += this.deps.repo.cancelIndexTasksForAsset(assetId);
    this.notify();
    return n;
  }

  // ---------- 统计 ----------
  stats(): PipelineStats {
    const rows = this.deps.repo.countIndexTasks();
    const byStage = new Map<Stage, Map<string, number>>();
    let running = 0, queued = 0, waitingRetry = 0, failed = 0, done = 0, cancelled = 0, skipped = 0;
    for (const r of rows) {
      const c = Number(r.count);
      const stage = r.stage as Stage;
      const m = byStage.get(stage) ?? new Map<string, number>();
      m.set(r.state, c);
      byStage.set(stage, m);
      if (r.state === "running") running += c;
      else if (r.state === "queued") queued += c;
      else if (r.state === "waiting_retry") waitingRetry += c;
      else if (r.state === "failed") failed += c;
      else if (r.state === "done") done += c;
      else if (r.state === "cancelled") cancelled += c;
      else if (r.state === "skipped") skipped += c;
    }
    const stages = STAGE_ORDER.map((stage) => {
      const m = byStage.get(stage) ?? new Map<string, number>();
      const metric = this.stageMetrics.get(stage);
      return {
        stage,
        queued: m.get("queued") ?? 0,
        running: m.get("running") ?? 0,
        waitingRetry: m.get("waiting_retry") ?? 0,
        failed: m.get("failed") ?? 0,
        done: m.get("done") ?? 0,
        skipped: m.get("skipped") ?? 0,
        avgMs: metric && metric.count ? Math.round(metric.ms / metric.count) : null,
      };
    });
    const mem = process.memoryUsage();
    return {
      started: this.started, paused: this.paused, startedAt: this.startedAt,
      running, queued, waitingRetry, failed, done, cancelled, skipped,
      stages,
      cache: this.deps.cache.stats(this.deps.limits.cacheMaxBytes),
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
      processed: this.processed, failures: this.failures, lastError: this.lastError,
    };
  }

  // ---------- 内部 ----------
  private concurrencyOf(stage: Stage): number {
    const l = this.deps.limits;
    switch (stage) {
      case "hash": return l.hashConcurrency;
      case "archive": return l.archiveConcurrency;
      case "unitypackage": return l.unityPackageConcurrency;
      case "thumbs": return l.thumbConcurrency;
      case "meta": return l.metaConcurrency;
      case "categorize": return l.categorizeConcurrency;
      case "fts": return l.ftsConcurrency;
    }
  }

  private timeoutOf(stage: Stage): number {
    const l = this.deps.limits;
    if (stage === "hash") return l.hashTimeoutMs;
    if (stage === "archive" || stage === "unitypackage") return l.archiveTimeoutMs;
    if (stage === "thumbs") return l.thumbTimeoutMs;
    return 60_000;
  }

  private async loop(stage: Stage): Promise<void> {
    while (!this.stopped) {
      if (this.paused) { await this.sleep(250); continue; }
      let task: any = null;
      try { task = this.deps.repo.claimIndexTask(stage); } catch (e) { this.deps.log("pipeline claim error: " + msgOf(e)); }
      if (!task) { await this.sleep(250); continue; }
      try { await this.execute(stage, task); } catch (e) { this.deps.log("pipeline execute crash: " + msgOf(e)); }
    }
  }

  private async execute(stage: Stage, task: any): Promise<void> {
    const repo = this.deps.repo;
    const asset = repo.getAsset(Number(task.asset_id)) as AssetRow | null;
    if (!asset || asset.status === "trashed") {
      repo.finishIndexTask(task.id, "skipped", { errorCode: "ASSET_GONE", error: "asset missing or trashed" }, { requireRunning: true });
      this.refreshAssetState(Number(task.asset_id));
      return;
    }
    // 前置校验：文件变了 → 本任务作废，整链重建（绝不把旧快照写进新文件）
    if (task.fingerprint && String(task.fingerprint) !== fingerprintOf(asset)) {
      repo.finishIndexTask(task.id, "skipped", { errorCode: "STALE", error: "file changed since enqueue" }, { requireRunning: true });
      repo.logPipelineEvent({ taskId: task.id, assetId: asset.id, stage, event: "stale", detail: "fingerprint " + task.fingerprint + " != " + fingerprintOf(asset) });
      this.cancelAsset(asset.id);
      this.enqueueAsset(asset.id, { priority: Number(task.priority) || 50 });
      this.refreshAssetState(asset.id);
      return;
    }

    const ac = new AbortController();
    this.controllers.set(Number(task.id), ac);
    const started = Date.now();
    const fn = stageFn(stage);
    const ctx: StageCtx = {
      repo, media: this.deps.media, cache: this.deps.cache, limits: this.deps.limits,
      log: this.deps.log, signal: ac.signal,
      progress: (p) => this.noteProgress(Number(task.id), p),
    };

    let timer: NodeJS.Timeout | null = null;
    try {
      const result = await Promise.race([
        fn(ctx, asset),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { ac.abort("timeout"); reject(Object.assign(new Error("阶段超时（" + this.timeoutOf(stage) + "ms）"), { code: "TIMEOUT" })); }, this.timeoutOf(stage));
          timer.unref?.();
        }),
      ]);
      this.flushTaskProgress(Number(task.id));
      this.complete(stage, task, asset, result, started);
    } catch (e) {
      this.flushTaskProgress(Number(task.id));
      this.fail(stage, task, asset, e, started);
    } finally {
      if (timer) clearTimeout(timer);
      this.controllers.delete(Number(task.id));
      this.processed++;
      this.stageMetrics.set(stage, { count: (this.stageMetrics.get(stage)?.count ?? 0) + 1, ms: (this.stageMetrics.get(stage)?.ms ?? 0) + (Date.now() - started) });
      this.refreshAssetState(asset.id);
      this.notify();
    }
  }

  private complete(stage: Stage, task: any, asset: AssetRow, result: StageResult, ms: number): void {
    const repo = this.deps.repo;
    if (result.limited) {
      repo.finishIndexTask(task.id, "skipped", { errorCode: result.limited.code, error: result.limited.message }, { requireRunning: true });
      repo.logPipelineEvent({ taskId: task.id, assetId: asset.id, stage, event: "limited", detail: JSON.stringify(result.limited) });
      this.deps.log("pipeline " + stage + " asset " + asset.id + " limited: " + result.limited.message);
      return;
    }
    if (result.skipped) {
      repo.finishIndexTask(task.id, "skipped", { errorCode: "NOT_APPLICABLE", error: result.skipped }, { requireRunning: true });
      return;
    }
    repo.finishIndexTask(task.id, "done", {}, { requireRunning: true });
    if (result.note) this.deps.log("pipeline " + stage + " asset " + asset.id + " ok: " + result.note + " (" + ms + "ms)");
  }

  private fail(stage: Stage, task: any, asset: AssetRow, e: unknown, ms: number): void {
    const repo = this.deps.repo;
    const code = String((e as any)?.code ?? "");
    const message = msgOf(e);
    if (code === "CANCELLED" || code === "ABORT_ERR" || (e instanceof CancelledError)) {
      repo.finishIndexTask(task.id, "cancelled", { errorCode: "CANCELLED", error: message }, { requireRunning: true });
      repo.logPipelineEvent({ taskId: task.id, assetId: asset.id, stage, event: "cancelled", detail: message });
      return;
    }
    this.failures++;
    this.lastError = { at: new Date().toISOString(), stage, assetId: asset.id, message };
    const attempts = Number(task.attempts) || 0;
    const max = Number(task.max_attempts) || this.deps.limits.taskMaxAttempts;
    const retryable = code !== "TIMEOUT" && !/ENOENT|EACCES|EPERM/i.test(message) ? attempts < max : attempts < max;
    if (retryable) {
      const backoff = Math.min(this.deps.limits.retryMaxMs, this.deps.limits.retryBaseMs * Math.pow(2, Math.max(0, attempts - 1)));
      repo.retryIndexTask(task.id, { errorCode: code || "ERROR", error: message, backoffMs: backoff });
      repo.logPipelineEvent({ taskId: task.id, assetId: asset.id, stage, event: "retry", detail: message + " (attempt " + attempts + "/" + max + ", backoff " + backoff + "ms)" });
      return;
    }
    repo.finishIndexTask(task.id, "failed", { errorCode: code || "ERROR", error: message }, { requireRunning: true });
    repo.logPipelineEvent({ taskId: task.id, assetId: asset.id, stage, event: "failed", detail: message });
    const skipped = repo.skipDependentTasks(task.id, "UPSTREAM_FAILED", "上游阶段失败: " + stage + " — " + message);
    this.deps.log("pipeline " + stage + " asset " + asset.id + " FAILED after " + attempts + " attempt(s): " + message + (skipped ? " (skipped " + skipped + " dependent)" : "") + " (" + ms + "ms)");
  }

  private refreshAssetState(assetId: number): void {
    try {
      const tasks: any[] = this.deps.repo.listIndexTasks({ assetId, limit: 50 });
      if (!tasks.length) return;
      const active = tasks.filter((t) => ["queued", "running", "waiting_retry"].includes(t.state));
      const failed = tasks.filter((t) => t.state === "failed");
      const limited = tasks.filter((t) => t.state === "skipped" && ["BYTES", "ENTRIES", "PIXELS", "RATIO"].includes(String(t.error_code)));
      let state = "done"; let error: string | null = null;
      if (active.some((t) => t.state === "running")) state = "running";
      else if (active.length) state = "queued";
      else if (failed.length) { state = "failed"; error = failed[0].error ?? null; }
      else if (limited.length) { state = "limited"; error = limited[0].error ?? null; }
      this.deps.repo.setAssetIndexState(assetId, state, error ? String(error).slice(0, 300) : null);
    } catch { /* 状态刷新失败不影响任务结果 */ }
  }

  private noteProgress(taskId: number, p: ProgressPatch): void {
    const cur = this.progress.get(taskId) ?? {};
    this.progress.set(taskId, { ...cur, ...p });
  }

  private flushTaskProgress(taskId: number): void {
    const p = this.progress.get(taskId);
    if (!p) return;
    try { this.deps.repo.updateIndexTask(taskId, p); } catch { /* ignore */ }
    this.progress.delete(taskId);
  }

  private flushProgress(): void {
    if (!this.progress.size) return;
    for (const [id] of [...this.progress]) this.flushTaskProgress(id);
  }

  private countsByState(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.deps.repo.countIndexTasks()) out[r.state] = (out[r.state] ?? 0) + Number(r.count);
    return out;
  }

  private notify(): void { for (const f of [...this.sleepers]) f(); }

  /** 空闲等待：所有睡着的 worker 共享一个唤醒集合；stop() 必须能把它们全部叫醒（否则 worker 永不结束）。 */
  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      let done = false;
      let t: NodeJS.Timeout;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        this.sleepers.delete(finish);
        resolve();
      };
      t = setTimeout(finish, ms);
      t.unref?.();
      this.sleepers.add(finish);
    });
  }
}

function msgOf(e: unknown): string {
  const err = e as any;
  return String(err?.message ?? err);
}
