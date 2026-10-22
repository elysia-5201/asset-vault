import { readdirSync, statSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { JobEvent, JobRow } from "../../../../packages/core/src/contracts";
import { normalizePath } from "../../../../packages/core/src/pathnorm";
import { BoothClient } from "../../../../packages/core/src/source/booth";
import { DEFAULT_JOB_HEARTBEAT_MS, DEFAULT_JOB_LEASE_MS, LeaseLostError, type JobFence, type JobLease, type Repo } from "../db/repo";
import { importBoothUrl } from "../services/booth";
import { indexAsset } from "../services/indexing";
import { matchItem } from "../services/match";
import { checkItemUpdate } from "../services/updates";
import { walkCandidates, planFromFiles, registerAssets, missingWriteGate, scannedFileOf, createBackpressureGate, type ScanManifest, type WalkBatchStats, type ScannedFile, type ScanStats } from "../services/scan";
import { generateScanPreview, finalizeApplyRun } from "../services/scanpreview";
import { analyzeItemStructure, executeImportPlan, markImportInterrupted } from "../services/structure";
import { unityClientFor } from "../services/unity";
import { applyCategoryEvidence } from "../services/categories";
import type { MediaStore } from "../services/media";
import type { IndexPipeline } from "../services/pipeline/pipeline";
import { DEFAULT_LIMITS, type PipelineLimits } from "../services/pipeline/limits";

export interface JobDeps {
  repo: Repo; media: MediaStore; booth: BoothClient; log: (msg: string) => void;
  pipeline?: IndexPipeline;
  /** 工作台导入执行用：默认按 settings/UNITY_MCP_URLS 构造；测试可注入假客户端。 */
  unity?: import("../services/unity").UnityMcp;
  /** 暂存目录根（默认系统 tmp）；server 传 dataDir。 */
  dataDir?: string;
  /** v0.6.1-G2：发现批大小/扫描上限/背压水位；缺省 DEFAULT_LIMITS（runJob 直调/嵌入式兼容）。 */
  limits?: PipelineLimits;
}

interface Scratch {
  note?: string;
  errors: string[];
  visibleFailures: { kind: "index" | "match" | "category"; target: string; message: string }[];
  /** 非扫描类作业（reindex）需要直接索引的资产；扫描类改为分批入队，不再全量累积。 */
  directIndexIds: number[];
  /** 非扫描类作业需要匹配/分类的条目 id（恒为 O(1) 条；扫描类走 TEMP scan_items 分批）。 */
  directItemIds: number[];
  /** 扫描类作业已批量入队的资产数（有界 drain 用；不保留 id 数组）。 */
  scanQueued: number;
}

const asError = (e: unknown): { message: string; code?: string } => {
  const err = e as any;
  return { message: String(err?.message ?? err), code: err?.code };
};

/**
 * ScanManifest 的 SQLite TEMP 表实现（v0.6.1-G2）。
 * scan.ts 只在 onBatch **成功返回后**调用 addMany（未提交/中止批次不记），这里负责一条多行落账；
 * has/size 供自测与诊断；finish 仅在 complete===true 时被 walk 调用，行已在批边界落账，无需收尾。
 */
function repoScanManifest(repo: Repo): ScanManifest {
  return {
    add(pathNorm: string): void { repo.insertScanSeenBatch([pathNorm]); },
    addMany(pathNorms: string[]): void { repo.insertScanSeenBatch(pathNorms); },
    get size(): number { return repo.scanSeenCount(); },
    has(pathNorm: string): boolean { return repo.scanSeenHas(pathNorm); },
    finish(): void { /* 无落盘清单：批边界已写 TEMP 表 */ },
  };
}

/** 扫描类作业的有界 drain：TEMP 表里的资产是否都已离开流水线（不持有 assetIds 数组）。 */
async function waitScanIndexed(repo: Repo, waitMs: number, ensureLease: () => void): Promise<boolean> {
  if (waitMs <= 0) return false;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    ensureLease();
    try { if (repo.countActiveScanAssets() === 0) return true; } catch { return false; }
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  return false;
}

/** reindex 等单资产作业的有界 drain（ids 数量恒为 1，沿用既有 countActiveIndexTasks）。 */
async function waitDirectIndexed(repo: Repo, ids: number[], waitMs: number, ensureLease: () => void): Promise<boolean> {
  if (waitMs <= 0) return false;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    ensureLease();
    try { if (repo.countActiveIndexTasks(ids) === 0) return true; } catch { return false; }
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  return false;
}

export interface RunJobOptions {
  /** v6 租约：所有状态转移/诊断事件都带它做 CAS 围栏；缺省=旧行为（直接调用/嵌入式）。 */
  lease?: JobLease;
  /** 租约丢失时由 runner abort；runJob 在每个让渡点与转移前检查。 */
  signal?: AbortSignal;
}

/** 把一条 queued 作业按冻结状态机跑完；失败走 stop→fail（锁必释放）。 */
export async function runJob(deps: JobDeps, jobId: number, opts: RunJobOptions = {}): Promise<void> {
  const { repo } = deps;
  const lease = opts.lease;
  // FIX-07：派生写入的作业围栏（有租约才传；嵌入式/直调/HTTP 路径保持无 fence 的旧行为）。
  const fence: JobFence | undefined = lease ? { jobId, holder: lease.holder, token: lease.token } : undefined;
  const signal = opts.signal;
  const scratch: Scratch = { errors: [], visibleFailures: [], directIndexIds: [], directItemIds: [], scanQueued: 0 };
  // task-20 R3：TEMP 条目清单对**所有**作业类型可用（匹配阶段统一从这里读；非扫描类只写 directItemIds）。
  // 扫描分支会在开始批次前再 reset 一次（清掉可能残留的旧行）。
  try { repo.resetScanItems(); } catch { /* 老连接/异常环境下退化为直接条目 */ }
  const job = (): JobRow => repo.getJob(jobId)!;
  /** 租约丢失去（心跳续租失败）后立刻中止，绝不再做状态转移。 */
  const ensureLease = (): void => {
    if (lease && signal?.aborted) throw new LeaseLostError(`job ${jobId} 租约已失效（心跳中断/被接管）`);
  };
  let lastYield = Date.now();
  /**
   * 长同步段（扫描 plan 循环 / match / category 循环里的 better-sqlite3 写）不像 await 那样给
   * 事件循环留空隙，会让心跳定时器停摆。这里按墙钟每 ~50ms 让渡一次 setImmediate。
   */
  const yieldIfDue = async (ms = 50): Promise<void> => {
    ensureLease();
    if (Date.now() - lastYield >= ms) {
      lastYield = Date.now();
      await new Promise<void>((r) => setImmediate(r));
      ensureLease();
    }
  };

  /**
   * 失败收尾必须**状态感知**（verifier A2）：
   *  - releasing → fail 是合法边；releasing_done 没有 fail 边 → 记诊断事件后按 succeed 收尾；
   *  - paused 没有 fail 边 → 保持暂停并留证据，绝不把作业永久卡在"在飞"。
   * 另外：领取已改为 CAS（repo.claimNextJob），竞争失败者根本不会进入这里。
   */
  const stopFail = (e: unknown): void => {
    const { message, code } = asError(e);
    // 租约丢失不是作业失败：作业已归新持有者（或已排队），这里只留一行日志/诊断，绝不做转移。
    if (e instanceof LeaseLostError || code === "LEASE_LOST") {
      deps.log(`job ${jobId} lease lost: ${message}`);
      try { repo.logJobEvent(jobId, null, "resolving", "lease_lost", message, lease); } catch { /* 围栏后丢弃 */ }
      return;
    }
    const cur = job();
    if (!cur) return;
    if (cur.state === "failed" || cur.state === "cancelled" || cur.state === "abandoned" || cur.state === "done") return;
    try {
      if (cur.state === "releasing") { repo.transitionJob(jobId, "fail", message, lease); }
      else if (cur.state === "releasing_done") {
        repo.logJobEvent(jobId, null, cur.state, "error_after_release", message, lease);
        repo.transitionJob(jobId, "succeed", undefined, lease);
      } else if (cur.state === "paused") {
        repo.logJobEvent(jobId, null, cur.state, "error_while_paused", message, lease);
      } else {
        repo.transitionJob(jobId, "stop", undefined, lease);
        repo.transitionJob(jobId, "fail", message, lease);
      }
    } catch (err2) {
      repo.logJobEvent(jobId, null, job()?.state ?? "failed", "fail_transition_error", String((err2 as Error)?.message ?? err2), lease);
    }
    deps.log(`job ${jobId} failed: ${message}`);
  };

  try {
    // 领取时已是 resolving（CAS），只有在旧路径（直接调用 runJob）才需要 start。
    if (job().state === "queued") repo.transitionJob(jobId, "start", undefined, lease);
    ensureLease();
    const payload: any = job().payload ? JSON.parse(job().payload!) : {};

    // ---- resolving ----
    if (job().kind === "scan" || job().kind === "import_file") {
      const rootRow = payload.rootId ? (repo.listRoots() as any[]).find((r) => r.id === payload.rootId) : null;
      const scanPath: string = payload.path ?? rootRow?.path;
      if (!scanPath) throw new Error("scan/import 缺少 path 或 rootId");
      const rootId = rootRow?.id ?? repo.ensureRoot(scanPath, "index_in_place").id;
      // import_file 可能直接指向单个文件（收件箱监听就是这种）；单文件不走目录遍历
      const isFile = statSync(scanPath).isFile();
      // M1：预览生成分支（只写 scan_preview_*，不建条目/资产；scanpreview 自己走 onBatch）
      if (payload.mode === "preview" && payload.previewId) {
        // task-20 R4：预览也接 limits（limit=本轮候选上限，batchSize=流式批大小，signal=可取消）
        const limits = deps.limits ?? DEFAULT_LIMITS;
        const previewId = Number(payload.previewId);
        try {
          const r = await generateScanPreview(repo, previewId, deps.log, {
            batchSize: Math.max(1, Math.floor(Number(limits.registerBatchSize) || 200)),
            limit: Math.max(1, Math.floor(Number(limits.maxScanFiles) || 20000)),
            signal,
          });
          ensureLease();
          scratch.note = "preview " + payload.previewId + ": " + r.state + " files=" + r.counts.total + " new=" + r.counts.new + " changed=" + r.counts.changed + " missing=" + r.counts.missing;
        } catch (e) {
          // FIX-01：生成抛错必须落终态（CAS 只从 scanning 出发；已被取消/接管则丢弃）
          try {
            repo.updateScanPreviewIf(previewId, ["scanning"], {
              state: "failed", error: String(asError(e).message).slice(0, 300), finished_at: new Date().toISOString(),
            });
          } catch { /* 预览收尾失败不掩盖原始错误 */ }
          throw e;
        }
      } else {
        const limits = deps.limits ?? DEFAULT_LIMITS;
        const maxDepth = payload.deep ? 10 : 6;
        const batchSize = Math.max(1, Math.floor(Number(limits.registerBatchSize) || 200));
        const maxScanFiles = Math.max(1, Math.floor(Number(limits.maxScanFiles) || 20000));
        const planRoot = isFile ? dirname(scanPath) : scanPath;
        const pathNorm = normalizePath(scanPath);
        const depthOf = (p: string) => {
          const rel = normalizePath(p).slice(pathNorm.length).replace(/^\/+/, "");
          return rel === "" ? 0 : rel.split("/").length - 1;
        };
        // v0.6.1-G2：只保留计数，不再保留 filesOut/seen/assetIds/fileNames（按批消费后立即丢弃）
        let filesSeen = 0, assetNew = 0, assetChanged = 0, assetQueued = 0, batches = 0, throttled = 0;
        let scan: ScanStats | null = null;
        let scanGate: { allowed: boolean; reasons: string[] } | null = null;
        const manifest = repoScanManifest(repo);
        repo.resetScanSeen();
        repo.resetScanItems(); // 清掉 runJob 开头可能建出的空表（只删行，不重复建表）
        // 背压闸门（task-20 R5）：depth 只看**本轮**入队资产的 queued（scan_assets），
        // 不再被全库历史积压永久拖住；另加整轮等待预算，避免 500 批 × 30s 的最坏情况。
        const throttleBudgetMs = positiveEnv("ASSETVAULT_SCAN_GATE_BUDGET_MS", 120_000);
        let throttleWaitedMs = 0;
        let throttleBudgetLogged = false;
        const gate = createBackpressureGate({
          depth: () => repo.countQueuedScanAssets(),
          highWater: Number(limits.queueHighWater ?? 0),
          lowWater: Number(limits.queueLowWater ?? 0),
          signal,
          maxWaitMs: positiveEnv("ASSETVAULT_SCAN_GATE_MAX_WAIT_MS", 30_000),
        });
        const waitGate = async () => {
          if (throttleWaitedMs >= throttleBudgetMs) {
            if (!throttleBudgetLogged) {
              throttleBudgetLogged = true;
              repo.logJobEvent(jobId, null, job().state, "discovery_throttle_budget_exhausted",
                JSON.stringify({ budgetMs: throttleBudgetMs, waitedMs: throttleWaitedMs }), lease);
              deps.log(`job ${jobId} discovery throttle budget exhausted (${throttleBudgetMs}ms): continue without waiting`);
            }
            return { waited: false, waitedMs: 0, throttled: false, depth: 0 };
          }
          const g = await gate.wait();
          throttleWaitedMs += g.waitedMs;
          return g;
        };
        /**
         * 一批 = gate.wait → planFromFiles → 一个事务（createItem + registerAssets）→ 批量入队 pipeline。
         * scan.ts 只在 onBatch **成功返回后**才把本批 path_norm 写进 manifest（未提交批次不记）。
         * 批内抛错 ⇒ 整批回滚 + walk 中止 + 作业失败；重放时 upsertAsset 幂等（created=0，无孤儿条目）。
         */
        const registerBatch = async (files: ScannedFile[], stats: WalkBatchStats | null): Promise<void> => {
          ensureLease();
          if (files.length === 0) return;
          const g = await waitGate();
          if (g.throttled) {
            throttled++;
            repo.logJobEvent(jobId, null, job().state, "discovery_throttled",
              JSON.stringify({ batch: stats?.batch ?? batches + 1, waitedMs: g.waitedMs, depth: g.depth }), lease);
            deps.log(`job ${jobId} discovery throttled at batch ${stats?.batch ?? batches + 1} (waited=${g.waitedMs}ms depth=${g.depth})`);
          }
          const plans = planFromFiles(planRoot, files);
          const changedIds: number[] = [];
          const batchItemIds: number[] = [];
          let enqueuedNow = 0;
          repo.transaction(() => {
            for (const plan of plans) {
              let itemId: number | null = null;
              if (plan.sourceItemId) {
                const ex = repo.getItemBySource("booth", plan.sourceItemId);
                if (ex) itemId = ex.id;
                else itemId = repo.createItem({ title: plan.title, source_site: "booth", source_item_id: plan.sourceItemId, id_confidence: plan.confidence, id_match_method: plan.method, status: "active" }).id;
              } else {
                // 幂等：该物理路径已登记过资产 → 复用它所属条目，不重复建卡
                for (const a of plan.assets) {
                  const ex = repo.getAssetByPathNorm(normalizePath(a.file.path));
                  if (ex) { itemId = ex.item_id; break; }
                }
                if (itemId === null) itemId = repo.createItem({ title: plan.title, source_site: "local", status: "inbox" }).id;
              }
              if (plan.sourceItemId && !repo.getItem(itemId)!.sourceUrl) {
                // D7 修复：自动匹配的条目必须带回溯链接，否则无法做更新检查基线
                const url = `https://booth.pm/ja/items/${plan.sourceItemId}`;
                repo.updateItem(itemId, { source_url: url, canonical_url: url }, fence);
              }
              batchItemIds.push(itemId);
              for (const a of plan.assets) {
                const reg = registerAssets(repo, rootId, scanPath, itemId, a.file, "scan");
                if (reg.created) assetNew++;
                else if (reg.changed) assetChanged++;
                if (reg.created || reg.changed) changedIds.push(reg.id);
              }
            }
            // v0.6.1 R2（热修）：入队与 TEMP 登记必须和建档同事务。否则 enqueue 抛错会留下
            // "资产已提交但没入队"，而重放时 created=0 永远不再入队（静默漏索引）。
            if (changedIds.length > 0 && deps.pipeline) {
              const p = deps.pipeline as any;
              if (typeof p.enqueueAssets === "function") p.enqueueAssets(changedIds, { priority: 50, jobId });
              else p.enqueueMany(changedIds, { priority: 50, jobId });
              repo.insertScanAssetsBatch(changedIds, fence);
              enqueuedNow = changedIds.length;
            }
            // task-20 R3：条目 id 写入 TEMP 清单（同事务；回滚不留脏行），替代无界 Set；
            // 匹配/分类阶段按批遍历并在每批后删除，内存只与批大小有关。
            repo.insertScanItemsBatch(batchItemIds);
          });
          filesSeen += files.length;
          batches++;
          if (changedIds.length > 0) {
            if (deps.pipeline) {
              // 已在批次事务内完成批量入队（不逐条 enqueue）；assetId 只进 TEMP 表供有界 drain
              assetQueued += enqueuedNow;
            } else {
              // 无流水线（嵌入式/未取得锁）：退回同步索引，但仍按批处理，不累积全量 id
              for (const id of changedIds) {
                await yieldIfDue();
                try {
                  const r = await indexAsset(repo, deps.media, id, { hashMaxBytes: payload.deep ? 8 * 1024 * 1024 * 1024 : 512 * 1024 * 1024, signal });
                  deps.log(`indexed asset ${id}: entries=${r.entries} upkg=${r.unityAssets} images=${r.images}`);
                } catch (e) {
                  scratch.errors.push(`asset ${id}: ${asError(e).message}`);
                  scratch.visibleFailures.push({ kind: "index", target: `asset:${id}`, message: asError(e).message });
                  deps.log(`index asset ${id} skipped: ${asError(e).message}`);
                }
              }
            }
          }
        };
        // AUD-08：apply 的判定是 mode/applyRunId，不是 files.length>0 ——
        // missing-only（files=[]）也必须走这条路，绝不能回退到整目录遍历。
        const isApply = payload.mode === "apply" || !!payload.applyRunId;
        const explicitFiles = Array.isArray(payload.files) ? (payload.files as string[]) : [];
        if (isApply || explicitFiles.length > 0) {
          // M1 apply：只处理用户勾选的显式文件，不遍历目录 ⇒ 后续 missing 门控自然跳过（scan=null）
          const files = explicitFiles.map((p) => scannedFileOf(String(p))).filter((x): x is ScannedFile => !!x);
          deps.log(`apply job ${jobId}: explicit files=${files.length}/${explicitFiles.length} (missingOnly=${isApply && explicitFiles.length === 0})`);
          for (let i = 0; i < files.length; i += batchSize) {
            const part = files.slice(i, i + batchSize);
            await registerBatch(part, { files: Math.min(i + part.length, files.length), dirs: 0, bytes: 0, truncated: false, batch: Math.floor(i / batchSize) + 1, batchFiles: part.length });
          }
        } else if (isFile) {
          const ext = extname(scanPath).toLowerCase();
          const sf: ScannedFile = {
            path: scanPath, size: statSync(scanPath).size, mtime: statSync(scanPath).mtime.toISOString(),
            container: ext.slice(1) as any, kind: ext === ".unitypackage" ? "unitypackage" : "archive",
          };
          await registerBatch([sf], { files: 1, dirs: 0, bytes: sf.size, truncated: false, batch: 1, batchFiles: 1 });
        } else {
          // 流式发现：walk 内部每批回调；filesOut 恒为空，不再把全量候选堆在内存里
          scan = await walkCandidates(scanPath, { maxDepth, limit: maxScanFiles, batchSize, manifest, signal, onBatch: (files, stats) => registerBatch(files, stats) });
          ensureLease();
        }
        // D6 修复 + M0/P1 护栏（语义不变）：只有"完整可信"的一轮才允许批量写 missing。
        // 判缺改走 TEMP 清单（NOT EXISTS），不再调用 listPresentAssetsUnderPath / 不再保留 seen Set。
        if (scan) {
          scanGate = missingWriteGate(scan);
          if (scanGate.allowed) {
            const missing = repo.listMissingUnderPath(pathNorm).filter((a) => depthOf(a.path) <= maxDepth).map((a) => a.id);
            repo.markAssetsMissing(missing, fence);
          } else {
            // 不完整的一轮：不写 missing，但必须留下可查询的证据（作业状态机不变，只追加诊断事件）。
            const skipped = repo.countMissingUnderPath(pathNorm);
            const detail = JSON.stringify({
              reasons: scanGate.reasons, skippedMissing: skipped, depthFiltered: false,
              manifestRows: repo.scanSeenCount(),
              files: scan.files, dirs: scan.dirs, bytes: scan.bytes, truncated: scan.truncated,
              errorCount: scan.errorCount, readability: scan.readability, sampleErrors: scan.errors.slice(0, 5),
            });
            repo.logJobEvent(jobId, null, job().state, "scan_incomplete", detail, lease);
            deps.log(`job ${jobId} scan incomplete (${scanGate.reasons.join(",")}); skipped marking ${skipped} asset(s) missing; root=${scanPath}`);
          }
        }
        // 用户确认过的"缺失"项：逐条写 missing（已有决策，不再经过整轮扫描的门控）
        if (Array.isArray(payload.markMissing) && payload.markMissing.length > 0) {
          const ids = (payload.markMissing as number[]).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
          if (ids.length) { repo.markAssetsMissing(ids, fence); deps.log(`apply job ${jobId}: marked ${ids.length} asset(s) missing (user-confirmed)`); }
        }
        scratch.scanQueued = assetQueued;
        scratch.note = `scan: files=${scan?.files ?? filesSeen} new=${assetNew} changed=${assetChanged} queued=${assetQueued} batches=${batches}${throttled ? " throttled=" + throttled : ""} ${isFile ? "(single file)" : ""}` +
          (scanGate && !scanGate.allowed ? ` INCOMPLETE(${scanGate.reasons.join(",")})` : "");
      }
    } else if (job().kind === "structure") {
      // task-38/47：容器/资源单元识别。失败只影响本次作业与诊断事件，不改 assets 索引状态。
      if (payload.all === true) {
        const onlyMissing = payload.onlyMissing === true;
        const targets = repo.listStructureScanTargets(onlyMissing);
        const deadline = Date.now() + 10 * 60 * 1000;
        let done = 0; let failedItems = 0; let units = 0;
        const failures: { itemId: number; message: string }[] = [];
        let truncated = false;
        for (const itemId of targets) {
          if (Date.now() > deadline) {
            truncated = true;
            repo.logJobEvent(jobId, null, job().state, "structure_all_deadline", JSON.stringify({ done, total: targets.length }), lease);
            break;
          }
          ensureLease();
          try {
            const analyzed = await analyzeItemStructure(repo, itemId, deps.log);
            done++; units += analyzed.units;
          } catch (e) {
            // 单项失败不中断整轮
            failedItems++;
            const message = (e as Error)?.message ?? String(e);
            failures.push({ itemId, message });
            deps.log("structure_all item " + itemId + " failed: " + message);
          }
          repo.logJobEvent(jobId, null, job().state, "structure_progress", JSON.stringify({
            itemId, done, failed: failedItems, units, total: targets.length,
          }), lease);
          await new Promise<void>((r) => setImmediate(r));
        }
        repo.logJobEvent(jobId, null, job().state, "structure_analyzed", JSON.stringify({
          all: true, onlyMissing, total: targets.length, done, failed: failedItems, units, truncated, failures: failures.slice(0, 10),
        }), lease);
        scratch.note = `structure_all: total=${targets.length} done=${done} failed=${failedItems} units=${units}` + (truncated ? " (deadline)" : "");
      } else {
        const itemId = Number(payload.itemId ?? job().item_id ?? 0);
        if (!itemId) throw new Error("structure 需要 itemId");
        const analyzed = await analyzeItemStructure(repo, itemId, deps.log);
        ensureLease();
        repo.logJobEvent(jobId, null, job().state, "structure_analyzed", JSON.stringify({
          itemId, assets: analyzed.assets, units: analyzed.units, relations: analyzed.relations,
          errors: analyzed.errors.slice(0, 10), errorCount: analyzed.errors.length,
        }), lease);
        scratch.note = `structure: item=${itemId} assets=${analyzed.assets} units=${analyzed.units} relations=${analyzed.relations} errors=${analyzed.errors.length}`;
      }
    } else if (job().kind === "import") {
      // task-42：导入执行走 Job。外部副作用绝不自动重试：失败/中断把 run 标 interrupted、计划标 failed。
      const planId = Number(payload.planId ?? 0);
      if (!planId) throw new Error("import 需要 planId");
      try {
        const result = await executeImportPlan({
          repo, log: deps.log,
          unity: deps.unity ?? unityClientFor(repo),
          stagingDir: join(deps.dataDir ?? tmpdir(), "unity-staging"),
          jobId,
        }, planId);
        ensureLease();
        scratch.note = `import: plan=${planId} run=${result.run.id} status=${result.run.status} items=${result.items.length}`;
      } catch (e) {
        markImportInterrupted(repo, planId, (e as Error)?.message ?? String(e));
        throw e;
      }
    } else if (job().kind === "reindex") {
      const id = payload.assetId ? Number(payload.assetId) : 0;
      if (id > 0) { scratch.directIndexIds.push(id); const a = repo.getAsset(id); if (a) scratch.directItemIds.push(a.item_id); }
    } else if (job().kind === "match_avatars") {
      if (!job().item_id) throw new Error("match_avatars 需要 item_id");
      scratch.directItemIds.push(job().item_id!);
    } else if (job().kind === "import_url") {
      const outcome = await importBoothUrl(repo, deps.media, deps.booth, String(payload.url));
      ensureLease();
      scratch.directItemIds.push(outcome.itemId);
      scratch.note = `import_url: item=${outcome.itemId} images=${outcome.images} files=${outcome.files} created=${outcome.created}`;
    } else if (job().kind === "check_update") {
      if (!job().item_id) throw new Error("check_update 需要 item_id");
      const o = await checkItemUpdate(repo, deps.booth, job().item_id!);
      ensureLease();
      scratch.note = `check_update: changed=${o.changed} ${o.kinds.join(",")}`;
      scratch.directItemIds.push(job().item_id!);
    } else {
      throw new Error(`未实现的作业类型: ${job().kind}`);
    }
    ensureLease();
    repo.transitionJob(jobId, "resolve_ok", undefined, lease);

    // ---- fetching（下载类目前为空实现；导入已在 resolving 完成）----
    repo.transitionJob(jobId, "fetch_ok", undefined, lease);

    // ---- materializing（资产已在批次事务内登记；这里只推进状态）----
    ensureLease();
    repo.transitionJob(jobId, "commit", undefined, lease);

    // ---- indexing（v0.6.1-G2：扫描类已在批边界批量入队；这里只做有界等待）----
    // 作业只负责"入队 + 有界等待"：大包不会把队列卡死，小文件的基础建档在 resolving 阶段就已可见。
    // 没有 pipeline（嵌入式/单测/未取得单写入者锁）时，扫描批次已在 registerBatch 内同步索引。
    if (deps.pipeline && scratch.scanQueued > 0) {
      const waitMs = Number(payload.indexWaitMs ?? 8000);
      const waited = await waitScanIndexed(repo, waitMs, ensureLease);
      ensureLease();
      deps.log(`job ${jobId}: ${scratch.scanQueued} asset(s) queued to pipeline` + (waited ? " (settled)" : " (still running in background)"));
    }
    if (scratch.directIndexIds.length > 0) {
      // reindex 等非扫描类：仍是"单资产入队 + 有界等待"（数量恒为 1，不涉及全量累积）
      const ids = scratch.directIndexIds;
      if (deps.pipeline) {
        const p = deps.pipeline as any;
        if (typeof p.enqueueAssets === "function") p.enqueueAssets(ids, { priority: 50, jobId });
        else p.enqueueMany(ids, { priority: 50, jobId });
        const waited = await waitDirectIndexed(repo, ids, Number(payload.indexWaitMs ?? 8000), ensureLease);
        ensureLease();
        deps.log(`job ${jobId}: ${ids.length} asset(s) queued to pipeline` + (waited ? " (settled)" : " (still running in background)"));
      } else {
        for (const id of ids) {
          await yieldIfDue();
          try {
            const r = await indexAsset(repo, deps.media, id, { hashMaxBytes: payload.deep ? 8 * 1024 * 1024 * 1024 : 512 * 1024 * 1024, signal });
            deps.log(`indexed asset ${id}: entries=${r.entries} upkg=${r.unityAssets} images=${r.images}`);
          } catch (e) {
            // 单个坏包/加密包/恶意条目路径不得让整个作业失败：记录后继续（可按需对单资产重跑 /reindex）
            scratch.errors.push(`asset ${id}: ${asError(e).message}`);
            scratch.visibleFailures.push({ kind: "index", target: `asset:${id}`, message: asError(e).message });
            deps.log(`index asset ${id} skipped: ${asError(e).message}`);
          }
        }
      }
    }
    ensureLease();
    repo.transitionJob(jobId, "index_ok", undefined, lease);

    // ---- matching + 自动分类（task-20 R3：条目 id 走 TEMP 清单分批遍历，每批后删除；内存与批大小相关）----
    const matchAndCategorize = async (itemId: number): Promise<void> => {
      await yieldIfDue();
      try {
        // 文件名证据由 matchItem 从已登记资产路径补全（不再在 runner 里累积 fileNames）
        const o = await matchItem(repo, itemId, {});
        if (o.addedItem + o.addedAsset > 0) deps.log(`avatars: item ${itemId} +${o.addedItem} item / +${o.addedAsset} asset (declared=${o.declared})`);
      } catch (e) {
        scratch.errors.push(`match item ${itemId}: ${asError(e).message}`);
        scratch.visibleFailures.push({ kind: "match", target: `item:${itemId}`, message: asError(e).message });
      }
      // 自动分类（§5-1/§5-3：扫库建档 / Inbox 入库在 indexing+matching 完成后；manual/confirmed 由
      // repo.applyAutoCategory 保护）。单条失败只记日志，绝不影响作业状态机。
      await yieldIfDue();
      try { applyCategoryEvidence(repo, itemId, { log: deps.log }); }
      catch (e) {
        scratch.visibleFailures.push({ kind: "category", target: `item:${itemId}`, message: asError(e).message });
        deps.log(`category item ${itemId} skipped: ${asError(e).message}`);
      }
    };
    for (const itemId of scratch.directItemIds) await matchAndCategorize(itemId);
    let itemCursor = 0;
    for (;;) {
      const batch = repo.listScanItemsBatch(itemCursor, 200);
      if (batch.length === 0) { repo.deleteScanItemsThrough(itemCursor); break; }
      for (const itemId of batch) await matchAndCategorize(itemId);
      itemCursor = batch[batch.length - 1]!;
      repo.deleteScanItemsThrough(itemCursor);
      await new Promise<void>((r) => setImmediate(r));
    }
    if (scratch.errors.length > 0) deps.log(`job ${jobId} partial failures (${scratch.errors.length}): ${scratch.errors.slice(0, 3).join(" | ")}`);
    // M0/P1：单条索引/匹配/分类失败在**现有** job event 机制里留一条可查询记录（GET /api/jobs/:id/events），
    // 不新建状态、不改状态机、不伪造成功：作业仍照旧先走 index_ok/match_ok/succeed；没有失败则不记事件。
    if (scratch.visibleFailures.length > 0) {
      // from=null：这是"诊断事件"，不是状态转移（与上面的 scan_incomplete 一致），
      // 否则 matching→matching 会伪造一条自环转移。
      repo.logJobEvent(jobId, null, job().state, "partial_failures", JSON.stringify({
        count: scratch.visibleFailures.length,
        sample: scratch.visibleFailures.slice(0, 10),
      }), lease);
    }
    // M1：apply 收尾（在 matching 之后、succeed 之前；失败不得让作业崩掉，只记日志）
    if (payload.applyRunId && payload.previewId) {
      try { finalizeApplyRun(repo, payload as any, scratch.visibleFailures, deps.log); }
      catch (e) { deps.log(`apply ${payload.applyRunId} finalize failed: ${asError(e).message}`); }
    }
    ensureLease();
    repo.transitionJob(jobId, "match_ok", undefined, lease);
    ensureLease();
    repo.transitionJob(jobId, "succeed", undefined, lease);
    if (scratch.note) deps.log(`job ${jobId} ok: ${scratch.note}`);
  } catch (e) {
    // 租约丢失导致的 walk/gate CANCELLED 一律按"丢租约"收尾（不做任何状态转移）
    if (lease && signal?.aborted) stopFail(new LeaseLostError(`job ${jobId} 租约已失效（心跳中断/被接管）`));
    else stopFail(e);
    // FIX-01：按作业终态收尾对应预览/应用（被用户取消 → cancelled；失败 → failed；paused 留给恢复）
    try {
      const jd: any = job()?.payload ? JSON.parse(job()!.payload!) : {};
      const previewId = Number(jd?.previewId ?? 0);
      const st = job()?.state;
      const target = st === "cancelled" ? "cancelled" : st === "failed" ? "failed" : null;
      if (previewId && target) {
        repo.updateScanPreviewIf(previewId, ["scanning", "applying"], {
          state: target, error: "作业" + (target === "cancelled" ? "已取消" : "失败") + ": " + asError(e).message.slice(0, 200),
          finished_at: new Date().toISOString(),
        });
      }
      if (jd?.applyRunId && target) {
        repo.updateScanApplyRunIf(Number(jd.applyRunId), ["running"], {
          state: target === "cancelled" ? "cancelled" : "failed", finished_at: new Date().toISOString(),
        });
      }
    } catch { /* 预览收尾失败不影响作业状态 */ }
  }
}

function positiveEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 简单串行 worker：一次一条，500ms 轮询。
 *
 * v6 租约：
 *  - 本实例用稳定 holder（host#pid#rand）领取，lease_token+1 作为 fencing token；
 *  - 作业运行期间每 15s 续租一次，续租失败 ⇒ abort（旧持有者的迟到写入被仓库层 CAS 拒绝）；
 *  - 独立维护定时器按心跳频率回收**过期**租约 —— 即使本进程 busy（长作业）也能让本进程
 *    崩溃/卡死留下的租约在别的进程/下一轮被接管；本进程自己的活租约绝不会被误伤。
 */
export class JobRunner {
  private timer: NodeJS.Timeout | null = null;
  private maintenance: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly holder = hostname() + "#" + process.pid + "#" + Math.random().toString(36).slice(2, 10);
  private readonly leaseMs = positiveEnv("ASSETVAULT_JOB_LEASE_MS", DEFAULT_JOB_LEASE_MS);
  private readonly heartbeatMs = positiveEnv("ASSETVAULT_JOB_HEARTBEAT_MS", DEFAULT_JOB_HEARTBEAT_MS);
  constructor(private deps: JobDeps) {}
  start(intervalMs = 500): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref?.();
    this.maintenance = setInterval(() => { this.safeReap(); }, this.heartbeatMs);
    this.maintenance.unref?.();
  }
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.maintenance) { clearInterval(this.maintenance); this.maintenance = null; }
  }
  private safeReap(): void {
    // 关键：运行期间绝不回收自己的过期租约。长同步段阻塞 > leaseMs 时本进程的 heartbeat 可能还
    // 没来得及跑，若 maintenance 把自己的在飞作业 reap 成 queued，会被再次领取 → 重复执行；自己的
    // 作业只由自己的 heartbeat 续/丢。跨进程接管不受影响（对方 holder 不同，照常按过期回收）。
    //
    // 只在 busy 时传 protectHolder：runJob 结束后若因 DB 错误把行留在自己名下且租约过期，本进程
    // 空闲时的下一轮回收仍应能自愈（否则单进程会永久卡住一条在飞作业）。
    try { this.deps.repo.reapExpiredLeases(this.busy ? { protectHolder: this.holder } : {}); }
    catch (e) { this.deps.log(`reap error: ${asError(e).message}`); }
  }
  async tick(): Promise<boolean> {
    if (this.busy) return false;
    // 先回收过期租约（崩溃/被强杀的旧持有者留下的行），再 CAS 领取。
    this.safeReap();
    // CAS 领取：多 runner 竞争时只有赢家拿到，输家绝不能去 stopFail 别人的作业（verifier A1）
    const job = this.deps.repo.claimNextJob(this.holder, { leaseMs: this.leaseMs });
    if (!job) return false;
    this.busy = true;
    const lease: JobLease = { holder: this.holder, token: Number(job.lease_token) };
    const ac = new AbortController();
    let beating = true;
    const beat = setInterval(() => {
      if (!beating) return;
      try {
        if (!this.deps.repo.renewLease(job.id, lease, { leaseMs: this.leaseMs })) {
          beating = false;
          ac.abort("lease-lost");
        }
      } catch { /* DB 瞬时错误不当作丢租约：下个心跳重试；真过期后由回收器接管 */ }
    }, this.heartbeatMs);
    beat.unref?.();
    try { await runJob(this.deps, job.id, { lease, signal: ac.signal }); }
    catch (e) { this.deps.log(`runner error: ${asError(e).message}`); }
    finally { beating = false; clearInterval(beat); this.busy = false; }
    return true;
  }
  async drain(maxJobs = 200): Promise<number> {
    let n = 0;
    while (n < maxJobs && await this.tick()) n++;
    return n;
  }
}

export { readdirSync as _readdir };
void (undefined as unknown as ScannedFile);
void (undefined as unknown as JobEvent);