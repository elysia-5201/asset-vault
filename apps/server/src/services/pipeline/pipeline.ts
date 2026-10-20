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
import type { EventRetentionState, Repo } from "../../db/repo";
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
  /** v7：任务归属的顶层作业 id（runner 透传；reap 时按 job 重置 running 子任务）。 */
  jobId?: number | null;
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
/** FIX-03：不可重试的永久错误码（与 isRetryableStageError 配套）。 */
const PERMANENT_STAGE_ERRORS = new Set([
  "ENOENT", "EACCES", "EPERM", "PERMISSION", "NOT_FOUND", "INVALID_INPUT", "NOT_AN_ARCHIVE", "ARCHIVE_PASSWORD",
]);
/** v7 任务围栏：领取时拿到的 owner + lease_token；所有进度/终态写入都必须带上。 */
interface TaskFence { owner: string; leaseToken: number }

export class IndexPipeline {
  private stopped = false;
  private started = false;
  private paused = false;
  private startedAt = new Date().toISOString();
  private workers: Promise<void>[] = [];
  private controllers = new Map<number, AbortController>();
  private progress = new Map<number, { patch: ProgressPatch; fence?: TaskFence; stage: Stage }>();
  /** 本 pipeline 实例的租约 owner（claim 时写入 index_tasks.owner）。 */
  private readonly owner = "pipeline#" + process.pid + "#" + Math.random().toString(36).slice(2, 10);
  /** 已被接管的任务 id（只记一次 lease_lost 诊断，避免刷屏）。 */
  private lostLogged = new Set<number>();
  private flushTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private retentionInitial: NodeJS.Timeout | null = null;
  /** 按阶段分组的空闲唤醒集合（task-17 #1）：notify 只唤醒相关阶段，不再全局广播。 */
  private sleepers = new Map<Stage, Set<() => void>>();
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
    // 事件保留（task-13）：启动 5s 后首跑，此后默认每 10min 一轮；只删事件表、不阻塞索引 worker。
    const retentionMs = positiveInt(process.env.ASSETVAULT_EVENT_RETENTION_MS, 10 * 60_000);
    this.retentionInitial = setTimeout(() => { void this.runRetention(); }, 5_000);
    this.retentionInitial.unref?.();
    this.retentionTimer = setInterval(() => { void this.runRetention(); }, retentionMs);
    this.retentionTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const ac of this.controllers.values()) ac.abort("shutdown");
    this.controllers.clear();
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
    if (this.retentionTimer) { clearInterval(this.retentionTimer); this.retentionTimer = null; }
    if (this.retentionInitial) { clearTimeout(this.retentionInitial); this.retentionInitial = null; }
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
      // 不再广播唤醒（task-17 #1）：worker 由 enqueue/任务完成/退避提升按阶段精确唤醒；
      // drain 只观察计数，每 25ms 的全局唤醒会让所有 worker 空 claim 一次。
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

    const chain: Stage[] = [];
    if (asset.container === "unitypackage") chain.push("unitypackage", "thumbs");
    else if (asset.container === "zip" || asset.container === "7z" || asset.container === "rar") chain.push("archive", "thumbs");
    else chain.push("hash");
    chain.push("meta", "categorize", "fts");

    // 哈希独立于解包（大包哈希与目录解析可以并行，但各自有独立并发上限）
    const plan: { stage: Stage; dependsOnStage: Stage | null }[] = [];
    if (chain[0] !== "hash") plan.push({ stage: "hash", dependsOnStage: null });
    let prev: Stage | null = null;
    for (const stage of chain) { plan.push({ stage, dependsOnStage: prev }); prev = stage; }

    // v0.6.1 task-17 #4：整链单事务 + 一次去重 SELECT + 同事务写 assets.index_state
    const ids = this.deps.repo.enqueueIndexTaskChain({
      assetId: asset.id, itemId: asset.item_id, priority,
      maxAttempts: this.deps.limits.taskMaxAttempts, fingerprint: fp, versionKey: "v1",
      stages: plan, assetState: { state: "queued", error: null },
      jobId: opts.jobId ?? null,
    });
    this.notifyStages(new Set(plan.map((p) => p.stage)));
    return ids;
  }

  /** 全库/筛选后重建（诊断面板与 CLI 用）。返回入队资产数。 */
  enqueueMany(assetIds: number[], opts: EnqueueOptions = {}): number {
    // task-20 R1：整批一个事务（内层 chain 通过 transactionIfNeeded 不再叠加 savepoint），
    // 10 万资产不再产生 10 万次独立提交；已在事务里（扫描批次）时直接复用外层事务。
    let n = 0;
    this.deps.repo.transactionIfNeeded(() => {
      for (const id of assetIds) { if (this.enqueueAsset(id, opts).length) n++; }
    });
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

  // ---------- 事件保留（task-13） ----------
  /**
   * 跑一轮事件保留（可重试；绝不抛给定时器）。
   * 双上限：时间（jobDays/pipelineDays）→ 条数（jobMaxRows/pipelineMaxRows）。
   * 硬边界：只删终态作业/无活跃任务的诊断事件；可删集合已空仍超条数上限时记录 blocked 并停止，
   * 绝不为达标而删 failed/活动/待恢复事件。每轮最多 20 个删除批（每批 ≤batchSize，clamp 500）。
   */
  async runRetention(): Promise<EventRetentionState> {
    const repo = this.deps.repo;
    const prev = repo.getRetentionState();
    const at = new Date().toISOString();
    const cfg = repo.getEventRetentionConfig();
    const state: EventRetentionState = {
      at, deletedJobEvents: 0, deletedPipelineEvents: 0, batches: 0,
      error: null, consecutiveFailures: prev?.consecutiveFailures ?? 0,
      blocked: { job: false, pipeline: false },
    };
    const cutoffJob = cfg.jobDays > 0 ? new Date(Date.parse(at) - cfg.jobDays * 86_400_000).toISOString() : null;
    const cutoffPipe = cfg.pipelineDays > 0 ? new Date(Date.parse(at) - cfg.pipelineDays * 86_400_000).toISOString() : null;
    try {
      while (state.batches < RETENTION_MAX_BATCHES) {
        let did = 0;
        // 1) 时间上限：终态作业 / 无活跃任务的诊断事件
        if (cutoffJob) {
          const n = repo.pruneJobEventsBatch({ cutoff: cutoffJob, limit: cfg.batchSize });
          if (n > 0) { state.deletedJobEvents += n; state.batches++; did += n; }
        }
        if (cutoffPipe) {
          const n = repo.prunePipelineEventsBatch({ cutoff: cutoffPipe, limit: cfg.batchSize });
          if (n > 0) { state.deletedPipelineEvents += n; state.batches++; did += n; }
        }
        // 2) 条数上限：只从"可删集合"里删；保护优先于达标
        if (cfg.jobMaxRows > 0) {
          const prunable = repo.countPrunableJobEvents();
          const over = prunable - cfg.jobMaxRows;
          if (over > 0) {
            const n = repo.pruneJobEventsBatch({ limit: Math.min(cfg.batchSize, over) });
            if (n > 0) { state.deletedJobEvents += n; state.batches++; did += n; }
          } else if (repo.countJobEvents() > cfg.jobMaxRows) {
            state.blocked.job = true;
          }
        }
        if (cfg.pipelineMaxRows > 0) {
          const prunable = repo.countPrunablePipelineEvents();
          const over = prunable - cfg.pipelineMaxRows;
          if (over > 0) {
            const n = repo.prunePipelineEventsBatch({ limit: Math.min(cfg.batchSize, over) });
            if (n > 0) { state.deletedPipelineEvents += n; state.batches++; did += n; }
          } else if (repo.countPipelineEvents() > cfg.pipelineMaxRows) {
            state.blocked.pipeline = true;
          }
        }
        if (did === 0) break;
        await new Promise<void>((r) => setImmediate(r)); // 批间让出，不阻塞索引 worker
      }
      state.consecutiveFailures = 0;
      repo.setRetentionState(state);
      const total = state.deletedJobEvents + state.deletedPipelineEvents;
      if (total > 0 || state.blocked.job || state.blocked.pipeline) {
        this.deps.log("event retention: deleted job=" + state.deletedJobEvents + " pipeline=" + state.deletedPipelineEvents +
          " batches=" + state.batches + (state.blocked.job || state.blocked.pipeline ? " (blocked: protected events exceed row cap, refusing to delete them)" : ""));
      }
      return state;
    } catch (e) {
      state.error = String((e as Error)?.message ?? e);
      state.consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;
      try { repo.setRetentionState(state); } catch { /* 记录失败不掩盖原始错误 */ }
      this.deps.log("event retention failed (" + state.consecutiveFailures + "): " + state.error);
      return state;
    }
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
      if (this.paused) { await this.sleep(stage, 250); continue; }
      let task: any = null;
      try { task = this.deps.repo.claimIndexTask(stage, this.owner); } catch (e) { this.deps.log("pipeline claim error: " + msgOf(e)); }
      if (!task) { await this.sleep(stage, 250); continue; }
      try { await this.execute(stage, task); } catch (e) { this.deps.log("pipeline execute crash: " + msgOf(e)); }
    }
  }

  private async execute(stage: Stage, task: any): Promise<void> {
    const repo = this.deps.repo;
    const fence = this.fenceOf(task);
    const finishOpts = { requireRunning: true, owner: fence?.owner, leaseToken: fence?.leaseToken };
    const asset = repo.getAsset(Number(task.asset_id)) as AssetRow | null;
    if (!asset || asset.status === "trashed") {
      if (repo.finishIndexTask(task.id, "skipped", { errorCode: "ASSET_GONE", error: "asset missing or trashed" }, finishOpts) === null) {
        this.leaseLost(stage, task, "finish");
        return;
      }
      this.maybeRefresh(Number(task.asset_id));
      this.notifyStages([stage, ...NEXT_STAGES[stage]]);
      return;
    }
    // 前置校验：文件变了 → 本任务作废，整链重建（绝不把旧快照写进新文件）
    if (task.fingerprint && String(task.fingerprint) !== fingerprintOf(asset)) {
      if (repo.finishIndexTask(task.id, "skipped", { errorCode: "STALE", error: "file changed since enqueue" }, finishOpts) === null) {
        this.leaseLost(stage, task, "finish");
        return;
      }
      repo.logPipelineEvent({ taskId: task.id, assetId: asset.id, stage, event: "stale", detail: "fingerprint " + task.fingerprint + " != " + fingerprintOf(asset) });
      this.cancelAsset(asset.id);
      this.enqueueAsset(asset.id, { priority: Number(task.priority) || 50, jobId: task.job_id ?? null });
      this.maybeRefresh(asset.id);
      this.notifyStages([stage, ...NEXT_STAGES[stage]]);
      return;
    }

    const ac = new AbortController();
    this.controllers.set(Number(task.id), ac);
    const started = Date.now();
    const fn = stageFn(stage);
    const ctx: StageCtx = {
      repo, media: this.deps.media, cache: this.deps.cache, limits: this.deps.limits,
      log: this.deps.log, signal: ac.signal,
      progress: (p) => this.noteProgress(Number(task.id), p, fence, stage),
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
      this.complete(stage, task, asset, result, started, fence);
    } catch (e) {
      this.flushTaskProgress(Number(task.id));
      this.fail(stage, task, asset, e, started, fence);
    } finally {
      if (timer) clearTimeout(timer);
      this.controllers.delete(Number(task.id));
      this.lostLogged.delete(Number(task.id));
      this.processed++;
      this.stageMetrics.set(stage, { count: (this.stageMetrics.get(stage)?.count ?? 0) + 1, ms: (this.stageMetrics.get(stage)?.ms ?? 0) + (Date.now() - started) });
      // task-17 #1：只唤醒本阶段（同阶段还有排队任务）与直接下游（依赖刚被满足）；
      // task-17 #3：不再每任务 refresh（改由 complete/fail 的 maybeRefresh 在链尾刷新）。
      this.notifyStages([stage, ...NEXT_STAGES[stage]]);
    }
  }

  private complete(stage: Stage, task: any, asset: AssetRow, result: StageResult, ms: number, fence?: TaskFence): void {
    const repo = this.deps.repo;
    const finishOpts = { requireRunning: true, owner: fence?.owner, leaseToken: fence?.leaseToken };
    if (result.limited) {
      if (repo.finishIndexTask(task.id, "skipped", { errorCode: result.limited.code, error: result.limited.message }, finishOpts) === null) {
        this.leaseLost(stage, task, "finish");
        return;
      }
      repo.logPipelineEvent({ taskId: task.id, assetId: asset.id, stage, event: "limited", detail: JSON.stringify(result.limited) });
      this.deps.log("pipeline " + stage + " asset " + asset.id + " limited: " + result.limited.message);
      this.maybeRefresh(asset.id);
      return;
    }
    if (result.skipped) {
      if (repo.finishIndexTask(task.id, "skipped", { errorCode: "NOT_APPLICABLE", error: result.skipped }, finishOpts) === null) {
        this.leaseLost(stage, task, "finish");
        return;
      }
      this.maybeRefresh(asset.id);
      return;
    }
    if (repo.finishIndexTask(task.id, "done", {}, finishOpts) === null) {
      this.leaseLost(stage, task, "finish");
      return;
    }
    this.maybeRefresh(asset.id);
    if (result.note) this.deps.log("pipeline " + stage + " asset " + asset.id + " ok: " + result.note + " (" + ms + "ms)");
  }

  private fail(stage: Stage, task: any, asset: AssetRow, e: unknown, ms: number, fence?: TaskFence): void {
    const repo = this.deps.repo;
    const finishOpts = { requireRunning: true, owner: fence?.owner, leaseToken: fence?.leaseToken };
    const code = String((e as any)?.code ?? "");
    const message = msgOf(e);
    if (code === "CANCELLED" || code === "ABORT_ERR" || (e instanceof CancelledError)) {
      if (repo.finishIndexTask(task.id, "cancelled", { errorCode: "CANCELLED", error: message }, finishOpts) === null) {
        this.leaseLost(stage, task, "finish");
        return;
      }
      repo.logPipelineEvent({ taskId: task.id, assetId: asset.id, stage, event: "cancelled", detail: message });
      this.maybeRefresh(asset.id);
      return;
    }
    const attempts = Number(task.attempts) || 0;
    const max = Number(task.max_attempts) || this.deps.limits.taskMaxAttempts;
    const retryable = this.isRetryableStageError(code, message, attempts, max);
    if (retryable) {
      const backoff = Math.min(this.deps.limits.retryMaxMs, this.deps.limits.retryBaseMs * Math.pow(2, Math.max(0, attempts - 1)));
      if (repo.retryIndexTask(task.id, { errorCode: code || "ERROR", error: message, backoffMs: backoff }, fence) === null && fence) {
        this.leaseLost(stage, task, "retry");
        return;
      }
      this.failures++;
      this.lastError = { at: new Date().toISOString(), stage, assetId: asset.id, message };
      repo.logPipelineEvent({ taskId: task.id, assetId: asset.id, stage, event: "retry", detail: message + " (attempt " + attempts + "/" + max + ", backoff " + backoff + "ms)" });
      return;
    }
    if (repo.finishIndexTask(task.id, "failed", { errorCode: code || "ERROR", error: message }, finishOpts) === null) {
      this.leaseLost(stage, task, "finish");
      return;
    }
    this.failures++;
    this.lastError = { at: new Date().toISOString(), stage, assetId: asset.id, message };
    repo.logPipelineEvent({ taskId: task.id, assetId: asset.id, stage, event: "failed", detail: message });
    const skipped = repo.skipDependentTasks(task.id, "UPSTREAM_FAILED", "上游阶段失败: " + stage + " — " + message);
    this.maybeRefresh(asset.id);
    this.deps.log("pipeline " + stage + " asset " + asset.id + " FAILED after " + attempts + " attempt(s): " + message + (skipped ? " (skipped " + skipped + " dependent)" : "") + " (" + ms + "ms)");
  }

  /**
   * task-17 #3：每链只刷一次资产索引状态（链尾/失败时）。展示状态最多滞后一个链时长，
   * 但省掉"每任务一次 refresh + listIndexTasks"的 6 倍固定成本；refresh 本身复用同一 SQL。
   */
  /**
   * FIX-03：显式重试判定（不再有恒等三元式）。
   * - 次数用尽 → 不重试；
   * - 瞬时错误（TIMEOUT / FILE_BUSY / EBUSY / EMFILE）→ 重试；
   * - 永久错误（ENOENT/EACCES/EPERM/PERMISSION/NOT_FOUND/INVALID_INPUT/NOT_AN_ARCHIVE/ARCHIVE_PASSWORD）→ 不重试；
   * - 其它未知错误 → 重试（保守，最多 max 次）。
   */
  private isRetryableStageError(code: string, message: string, attempts: number, max: number): boolean {
    if (attempts >= max) return false;
    const c = code.toUpperCase();
    if (c === "TIMEOUT" || c === "FILE_BUSY" || c === "EBUSY" || c === "EMFILE") return true;
    if (PERMANENT_STAGE_ERRORS.has(c)) return false;
    if (/ENOENT|EACCES|EPERM/i.test(message) && !/busy|locked/i.test(message)) return false;
    return true;
  }

  private maybeRefresh(assetId: number): void {
    try {
      if (this.deps.repo.countActiveIndexTasks([assetId]) === 0) this.refreshAssetState(assetId);
    } catch { /* 刷新失败不影响任务结果 */ }
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

  private noteProgress(taskId: number, p: ProgressPatch, fence: TaskFence | undefined, stage: Stage): void {
    const cur = this.progress.get(taskId)?.patch ?? {};
    this.progress.set(taskId, { patch: { ...cur, ...p }, fence, stage });
  }

  private flushTaskProgress(taskId: number): void {
    const entry = this.progress.get(taskId);
    if (!entry) return;
    try {
      // v7：进度写入同样带 owner+token CAS；被接管后 0 行 → 只记一条 lease_lost，不抛错
      if (this.deps.repo.updateIndexTask(taskId, entry.patch, entry.fence) === false) {
        this.leaseLost(entry.stage, { id: taskId }, "progress");
      }
    } catch { /* ignore */ }
    this.progress.delete(taskId);
  }

  /** claim 返回的 owner/lease_token → 围栏；旧任务（owner NULL）返回 undefined（未围栏兼容路径）。 */
  private fenceOf(task: any): TaskFence | undefined {
    if (!task || task.owner === null || task.owner === undefined) return undefined;
    return { owner: String(task.owner), leaseToken: Number(task.lease_token) || 0 };
  }

  /** 被接管后的迟到写入：只记一条 pipeline_events(lease_lost)，不刷屏、不影响新持有者。 */
  private leaseLost(stage: Stage, task: any, where: string): void {
    const id = Number(task?.id);
    if (!Number.isFinite(id)) return;
    if (this.lostLogged.has(id)) return;
    this.lostLogged.add(id);
    try {
      this.deps.repo.logPipelineEvent({ taskId: id, assetId: task?.asset_id ?? null, stage, event: "lease_lost", detail: "task taken over; stale " + where + " discarded" });
    } catch { /* ignore */ }
    this.deps.log("pipeline " + stage + " task " + id + " lease lost; stale " + where + " discarded");
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

  /** 低频全量唤醒（stop/resume/退避提升/boost/cancel）：必须能把所有 worker 叫醒。 */
  private notifyAll(): void {
    for (const set of this.sleepers.values()) for (const f of [...set]) f();
  }
  /** 兼容旧调用点（stop/resume 等）；热路径一律用 notifyStages。 */
  private notify(): void { this.notifyAll(); }

  /**
   * 定向唤醒（task-17 #1）：只叫醒这些阶段的空闲 worker。广播会让每任务完成时 8 个 worker
   * 全部醒来各空 claim 一次（实测 5 次/任务），是固定成本的最大头。
   */
  private notifyStages(stages: Iterable<Stage>): void {
    for (const stage of stages) {
      const set = this.sleepers.get(stage);
      if (set) for (const f of [...set]) f();
    }
  }

  /** 空闲等待：按阶段登记唤醒函数；stop()/notifyAll 能全部叫醒（否则 worker 永不结束）。 */
  private async sleep(stage: Stage, ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      let done = false;
      let t: NodeJS.Timeout;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        const set = this.sleepers.get(stage);
        set?.delete(finish);
        if (set && set.size === 0) this.sleepers.delete(stage);
        resolve();
      };
      t = setTimeout(finish, ms);
      t.unref?.();
      let set = this.sleepers.get(stage);
      if (!set) { set = new Set(); this.sleepers.set(stage, set); }
      set.add(finish);
    });
  }
}

/** 阶段完成/失败后，下一个可能变为可领取的直接下游阶段（与 enqueueAsset 的链构造一致）。 */
const NEXT_STAGES: Record<Stage, readonly Stage[]> = {
  hash: [],
  archive: ["thumbs"],
  unitypackage: ["thumbs"],
  thumbs: ["meta"],
  meta: ["categorize"],
  categorize: ["fts"],
  fts: [],
};

const RETENTION_MAX_BATCHES = 20;

function positiveInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function msgOf(e: unknown): string {
  const err = e as any;
  return String(err?.message ?? err);
}
