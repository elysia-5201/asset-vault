import { readdirSync, statSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import type { JobEvent, JobRow } from "../../../../packages/core/src/contracts";
import { normalizePath } from "../../../../packages/core/src/pathnorm";
import { BoothClient } from "../../../../packages/core/src/source/booth";
import type { Repo } from "../db/repo";
import { importBoothUrl } from "../services/booth";
import { indexAsset } from "../services/indexing";
import { matchItem } from "../services/match";
import { checkItemUpdate } from "../services/updates";
import { walkCandidates, planFromFiles, registerAssets, type ScannedFile } from "../services/scan";
import type { MediaStore } from "../services/media";

export interface JobDeps { repo: Repo; media: MediaStore; booth: BoothClient; log: (msg: string) => void }

interface Scratch { assetIds: number[]; itemIds: Set<number>; note?: string; errors: string[] }

const asError = (e: unknown): { message: string; code?: string } => {
  const err = e as any;
  return { message: String(err?.message ?? err), code: err?.code };
};

/** 把一条 queued 作业按冻结状态机跑完；失败走 stop→fail（锁必释放）。 */
export async function runJob(deps: JobDeps, jobId: number): Promise<void> {
  const { repo } = deps;
  const scratch: Scratch = { assetIds: [], itemIds: new Set(), errors: [] };
  const scratchByItem = new Map<number, { fileNames: string[] }>();
  const job = (): JobRow => repo.getJob(jobId)!;

  const stopFail = (e: unknown): void => {
    const { message } = asError(e);
    const cur = job();
    if (!cur) return;
    if (cur.state === "failed" || cur.state === "cancelled" || cur.state === "abandoned" || cur.state === "done") return;
    try { repo.transitionJob(jobId, "stop"); } catch { return; }
    try { repo.transitionJob(jobId, "fail", message); } catch { /* 并发取消等：忽略 */ }
    deps.log(`job ${jobId} failed: ${message}`);
  };

  try {
    repo.transitionJob(jobId, "start");
    const payload: any = job().payload ? JSON.parse(job().payload!) : {};

    // ---- resolving ----
    if (job().kind === "scan" || job().kind === "import_file") {
      const target: string = payload.path ?? deps.repo.getRootByPathNorm(payload.rootId ? "" : "")?.path ?? payload.path;
      const rootRow = payload.rootId ? (repo.listRoots() as any[]).find((r) => r.id === payload.rootId) : null;
      const scanPath: string = payload.path ?? rootRow?.path;
      if (!scanPath) throw new Error("scan/import 缺少 path 或 rootId");
      const rootId = rootRow?.id ?? repo.ensureRoot(scanPath, "index_in_place").id;
      // import_file 可能直接指向单个文件（收件箱监听就是这种）；单文件不走目录遍历
      const isFile = statSync(scanPath).isFile();
      let filesOut: ScannedFile[];
      if (isFile) {
        const ext = extname(scanPath).toLowerCase();
        filesOut = [{ path: scanPath, size: statSync(scanPath).size, mtime: statSync(scanPath).mtime.toISOString(),
          container: ext.slice(1) as any, kind: ext === ".unitypackage" ? "unitypackage" : "archive" }];
      } else {
        const s = await walkCandidates(scanPath, { maxDepth: payload.deep ? 10 : 6 });
        filesOut = s.filesOut;
        var stats: any = s;
      }
      const planRoot = isFile ? dirname(scanPath) : scanPath;
      const plans = planFromFiles(planRoot, filesOut);
      for (const plan of plans) {
        let itemId: number | null = null;
        if (plan.sourceItemId) {
          const ex = repo.getItemBySource("booth", plan.sourceItemId);
          if (ex) itemId = ex.id;
          else {
            const row = repo.createItem({ title: plan.title, source_site: "booth", source_item_id: plan.sourceItemId, id_confidence: plan.confidence, id_match_method: plan.method, status: "active" });
            itemId = row.id;
          }
        } else {
          // 幂等：该物理路径已登记过资产 → 复用它所属条目，不重复建卡
          for (const a of plan.assets) {
            const ex = repo.getAssetByPathNorm(normalizePath(a.file.path));
            if (ex) { itemId = ex.item_id; break; }
          }
          if (itemId === null) {
            const row = repo.createItem({ title: plan.title, source_site: "local", status: "inbox" });
            itemId = row.id;
            deps.log(`scan: 新 inbox 条目 "${plan.title}" (无商品号)`);
          }
        }
        if (plan.sourceItemId && !repo.getItem(itemId)!.sourceUrl) {
          // D7 修复：自动匹配的条目必须带回溯链接，否则无法做更新检查基线
          const url = `https://booth.pm/ja/items/${plan.sourceItemId}`;
          repo.updateItem(itemId, { source_url: url, canonical_url: url });
        }
        scratch.itemIds.add(itemId);
        for (const a of plan.assets) {
          const reg = registerAssets(repo, rootId, scanPath, itemId, a.file, "scan");
          if (reg.created) scratch.assetIds.push(reg.id);
          const s = scratchByItem.get(itemId) ?? { fileNames: [] };
          s.fileNames.push(basename(a.file.path));
          scratchByItem.set(itemId, s);
        }
      }
      // D6 修复：扫描后把"本根下未再出现"的资产标 missing（有界深度内；单文件导入跳过此步）
      const maxDepth = payload.deep ? 10 : 6;
      if (!isFile) {
      const seen = new Set(filesOut.map((f) => normalizePath(f.path)));
      const existing = repo.listPresentAssetsUnderPath(normalizePath(scanPath));
      const depthOf = (p: string) => {
        const rel = normalizePath(p).slice(normalizePath(scanPath).length).replace(/^\/+/, "");
        return rel === "" ? 0 : rel.split("/").length - 1;
      };
      const missingIds = existing.filter((a) => depthOf(a.path) <= maxDepth && !seen.has(a.path_norm)).map((a) => a.id);
      repo.markAssetsMissing(missingIds);
      }
      scratch.note = `scan: files=${filesOut.length} newAssets=${scratch.assetIds.length} ${isFile ? "(single file)" : ""}`;
    } else if (job().kind === "reindex") {
      scratch.assetIds = payload.assetId ? [payload.assetId] : [];
      const a = payload.assetId ? repo.getAsset(payload.assetId) : null;
      if (a) { scratch.itemIds.add(a.item_id); scratchByItem.set(a.item_id, { fileNames: [basename(a.path)] }); }
    } else if (job().kind === "match_avatars") {
      if (!job().item_id) throw new Error("match_avatars 需要 item_id");
      scratch.itemIds.add(job().item_id!);
    } else if (job().kind === "import_url") {
      const outcome = await importBoothUrl(repo, deps.media, deps.booth, String(payload.url));
      scratch.itemIds.add(outcome.itemId);
      scratch.note = `import_url: item=${outcome.itemId} images=${outcome.images} files=${outcome.files} created=${outcome.created}`;
    } else if (job().kind === "check_update") {
      if (!job().item_id) throw new Error("check_update 需要 item_id");
      const o = await checkItemUpdate(repo, deps.booth, job().item_id!);
      scratch.note = `check_update: changed=${o.changed} ${o.kinds.join(",")}`;
      scratch.itemIds.add(job().item_id!);
    } else {
      throw new Error(`未实现的作业类型: ${job().kind}`);
    }
    repo.transitionJob(jobId, "resolve_ok");

    // ---- fetching（下载类目前为空实现；导入已在 resolving 完成）----
    repo.transitionJob(jobId, "fetch_ok");

    // ---- materializing（原子落位已由 media/scan 完成；此处只做校验）----
    for (const id of scratch.assetIds) {
      const a = repo.getAsset(id);
      if (!a) throw new Error(`资产 ${id} 登记失败`);
    }
    repo.transitionJob(jobId, "commit");

    // ---- indexing ----
    for (const id of scratch.assetIds) {
      try {
        const r = await indexAsset(repo, deps.media, id, { hashMaxBytes: payload.deep ? 8 * 1024 * 1024 * 1024 : 512 * 1024 * 1024 });
        deps.log(`indexed asset ${id}: entries=${r.entries} upkg=${r.unityAssets} images=${r.images}`);
      } catch (e) {
        // 单个坏包/加密包/恶意条目路径不得让整个作业失败：记录后继续（可按需对单资产重跑 /reindex）
        scratch.errors.push(`asset ${id}: ${asError(e).message}`);
        deps.log(`index asset ${id} skipped: ${asError(e).message}`);
      }
    }
    repo.transitionJob(jobId, "index_ok");

    // ---- matching ----
    for (const itemId of scratch.itemIds) {
      try {
        const o = matchItem(repo, itemId, scratchByItem.get(itemId) ?? {});
        if (o.addedItem + o.addedAsset > 0) deps.log(`avatars: item ${itemId} +${o.addedItem} item / +${o.addedAsset} asset (declared=${o.declared})`);
      } catch (e) { scratch.errors.push(`match item ${itemId}: ${asError(e).message}`); }
    }
    if (scratch.errors.length > 0) deps.log(`job ${jobId} partial failures (${scratch.errors.length}): ${scratch.errors.slice(0, 3).join(" | ")}`);
    repo.transitionJob(jobId, "match_ok");
    repo.transitionJob(jobId, "succeed");
    if (scratch.note) deps.log(`job ${jobId} ok: ${scratch.note}`);
  } catch (e) {
    stopFail(e);
  }
}

/** 简单串行 worker：一次一条，500ms 轮询；崩溃恢复由启动时 recoverInFlight 负责。 */
export class JobRunner {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private deps: JobDeps) {}
  start(intervalMs = 500): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  async tick(): Promise<boolean> {
    if (this.busy) return false;
    const job = this.deps.repo.nextQueuedJob();
    if (!job) return false;
    this.busy = true;
    try { await runJob(this.deps, job.id); } catch (e) { this.deps.log(`runner error: ${asError(e).message}`); } finally { this.busy = false; }
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