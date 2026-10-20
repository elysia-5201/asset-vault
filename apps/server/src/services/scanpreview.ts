/**
 * 扫描变更中心（M1）——把一轮扫描变成**可确认的持久化清单**，用户勾选后再应用。
 *
 * 设计边界（与 docs 一致）：
 *  - 预览只读：生成阶段不写 items/assets，只写 scan_preview_*；
 *  - 应用只做三件事：登记新文件 / 重新索引变化的文件 / 把确认缺失的资产标 missing；
 *    **不移动、不删除原始文件，也不自动合并重复项**；
 *  - 判缺沿用 M0 门控：只有完整可信的扫描才提出 missing 项；
 *  - 应用前逐条重新 stat（path + size + mtime），与预览时不一致即标 stale，绝不按旧快照写库；
 *  - 同名同尺寸只能产生"疑似重复"提示，不构成合并依据。
 *
 * v0.6.0 阶段 A：分类改为**可流式喂入**（createPreviewClassifier），走 walkCandidates 的 onBatch，
 * 避免"全量 ScannedFile 数组 + 全量 rows 数组"同时驻留；行序与语义与旧的 classifyPreview 完全一致。
 */
import { statSync } from "node:fs";
import { basename } from "node:path";
import { normalizePath } from "../../../../packages/core/src/pathnorm";
import { missingWriteGate, walkCandidates, type ScanIssue, type ScanStats, type ScannedFile } from "./scan";
import { now, sha256Text } from "../util";
import type { Repo } from "../db/repo";

export const PREVIEW_GENERATOR_VERSION = 1;

export type PreviewChange = "new" | "unchanged" | "changed" | "missing" | "duplicate_suspected" | "unreadable" | "error";
export interface PreviewCounts { total: number; new: number; unchanged: number; changed: number; missing: number; duplicate_suspected: number; unreadable: number; error: number }
export interface PreviewRow {
  path: string; path_norm: string; change: PreviewChange;
  size?: number | null; mtime?: string | null; prevSize?: number | null; prevMtime?: string | null;
  assetId?: number | null; itemId?: number | null; container?: string | null; kind?: string | null; detail?: unknown;
}

const emptyCounts = (): PreviewCounts => ({ total: 0, new: 0, unchanged: 0, changed: 0, missing: 0, duplicate_suspected: 0, unreadable: 0, error: 0 });

/** 预览生成进度（v0.6.0 阶段 A：给上层报进度，不改变任何落库语义）。 */
export interface PreviewProgress {
  phase: "walk" | "classify" | "commit";
  /** 已扫到的候选文件数（累计）。 */
  files: number;
  /** 已枚举目录数（累计）。 */
  dirs: number;
  /** 已扫到候选的字节数（累计）。 */
  bytes: number;
  /** 已分类出的预览行数（累计）。 */
  rows: number;
}

export interface PreviewGenerateOptions {
  /** 每批扫描回调后、分类完成时、落库完成时各调一次；异常被吞掉（进度不许拖垮预览）。 */
  onProgress?: (p: PreviewProgress) => void;
  /** 透传给 walkCandidates 的批大小。 */
  batchSize?: number;
  /** 取消信号；中止会抛 code="CANCELLED"。 */
  signal?: AbortSignal;
}

/** 可流式喂入的预览分类器：先按批 push(文件)，最后 finish(扫描统计) 收尾得到完整 rows/counts/gate。 */
export interface PreviewClassifier {
  readonly rows: PreviewRow[];
  /** 喂入一批候选文件（行序 = 喂入顺序，与一次性 classifyPreview 完全一致）。 */
  push(files: ScannedFile[]): void;
  /** 收尾：判缺（过 missingWriteGate）+ 读取失败行 + 计数。 */
  finish(scan: Pick<ScanStats, "truncated" | "errorCount" | "readability" | "errors">): { rows: PreviewRow[]; counts: PreviewCounts; gate: { allowed: boolean; reasons: string[] } };
}

/**
 * 建一个预览分类器（读一次库内 existing 资产，之后逐批分类）。
 * 性能：疑似重复提示用「size + 小写 basename」建索引，避免旧写法 O(新文件 × 已有资产) 的 filter
 * （实测 2000×2000 已 24ms，20000×20000 会到秒级并卡住事件循环）。
 */
export function createPreviewClassifier(repo: Repo, scanPath: string): PreviewClassifier {
  const root = normalizePath(scanPath);
  const existing = repo.presentAssetsUnderPath(root);
  const byPath = new Map(existing.map((a) => [a.path_norm, a]));
  const existingByNameSize = new Map<string, typeof existing>();
  for (const a of existing) {
    const key = Number(a.size) + "|" + basename(normalizePath(a.path));
    const list = existingByNameSize.get(key);
    if (list) list.push(a);
    else existingByNameSize.set(key, [a]);
  }
  const seen = new Set<string>();
  const rows: PreviewRow[] = [];

  const push = (files: ScannedFile[]): void => {
    for (const f of files) {
      const pn = normalizePath(f.path);
      seen.add(pn);
      const cur = byPath.get(pn);
      if (cur) {
        const same = Number(cur.size) === f.size && (cur.mtime ?? "") === f.mtime;
        rows.push({
          path: f.path, path_norm: pn, change: same ? "unchanged" : "changed",
          size: f.size, mtime: f.mtime, prevSize: cur.size, prevMtime: cur.mtime,
          assetId: cur.id, itemId: cur.item_id, container: f.container, kind: f.kind,
        });
        continue;
      }
      // 弱重复提示：同名 + 同尺寸的已有资产。**只提示**，用户接受后仍按新文件登记。
      const dup = existingByNameSize.get(Number(f.size) + "|" + basename(pn)) ?? [];
      rows.push({
        path: f.path, path_norm: pn, change: dup.length ? "duplicate_suspected" : "new",
        size: f.size, mtime: f.mtime, assetId: null, itemId: null, container: f.container, kind: f.kind,
        detail: dup.length ? { hint: "存在同名同尺寸的已有资产（仅供参考，不会自动合并）", matches: dup.slice(0, 5).map((a) => a.path) } : undefined,
      });
    }
  };

  const finish = (scan: Pick<ScanStats, "truncated" | "errorCount" | "readability" | "errors">) => {
    // 判缺沿用 M0 门控：不完整的一轮不提出 missing（"没看到"可能只是"没读到"）
    const gate = missingWriteGate(scan);
    if (gate.allowed) {
      for (const a of existing) {
        if (seen.has(a.path_norm)) continue;
        rows.push({ path: a.path, path_norm: a.path_norm, change: "missing", prevSize: a.size, prevMtime: a.mtime, assetId: a.id, itemId: a.item_id });
      }
    }
    // 读取失败：readdir 失败记 error（目录），stat 失败记 unreadable（条目存在但读不到）
    for (const e of scan.errors) pushIssue(rows, e);

    const counts = emptyCounts();
    for (const r of rows) { counts.total++; counts[r.change] = (counts[r.change] ?? 0) + 1; }
    return { rows, counts, gate };
  };

  return { rows, push, finish };
}

/** 把扫描结果与库内现有资产对齐，产出逐条变化（一次性版本；行序/语义与 createPreviewClassifier 一致）。 */
export function classifyPreview(
  repo: Repo,
  scanPath: string,
  files: ScannedFile[],
  scan: Pick<ScanStats, "truncated" | "errorCount" | "readability" | "errors">,
): { rows: PreviewRow[]; counts: PreviewCounts; gate: { allowed: boolean; reasons: string[] } } {
  const c = createPreviewClassifier(repo, scanPath);
  c.push(files);
  return c.finish(scan);
}

function pushIssue(rows: PreviewRow[], e: ScanIssue): void {
  rows.push({
    path: e.path, path_norm: normalizePath(e.path), change: e.op === "stat" ? "unreadable" : "error",
    detail: { op: e.op, code: e.code, message: e.message },
  });
}

/**
 * 生成预览（在 scan job 里跑）：遍历 → 对齐 → 落库 → 状态 ready/partial/failed + planHash。
 * v0.6.0 阶段 A：走 walkCandidates 的 onBatch 流式分类（每批一次 push），可选 onProgress 报进度；
 * 落库仍是一次 replaceScanPreviewItems（预览是快照语义，repo 不做增量接口）。
 */
export async function generateScanPreview(
  repo: Repo,
  previewId: number,
  log: (m: string) => void = () => {},
  opts: PreviewGenerateOptions = {},
): Promise<{ state: string; counts: PreviewCounts; gate: { allowed: boolean; reasons: string[] } }> {
  const p = repo.getScanPreview(previewId);
  if (!p) throw new Error("预览不存在: " + previewId);
  const deep = !!p.deep;
  const notify = (q: PreviewProgress): void => { try { opts.onProgress?.(q); } catch { /* 进度回调不许拖垮预览 */ } };
  const classifier = createPreviewClassifier(repo, p.path);
  const scan = await walkCandidates(p.path, {
    maxDepth: deep ? 10 : 6,
    batchSize: opts.batchSize,
    signal: opts.signal,
    onBatch: (files, st) => {
      classifier.push(files);
      notify({ phase: "walk", files: st.files, dirs: st.dirs, bytes: st.bytes, rows: classifier.rows.length });
    },
  });
  const { rows, counts, gate } = classifier.finish(scan);
  notify({ phase: "classify", files: scan.files, dirs: scan.dirs, bytes: scan.bytes, rows: rows.length });
  repo.replaceScanPreviewItems(previewId, rows);
  if (scan.errors.length) {
    repo.addScanPreviewErrors(previewId, scan.errors.map((e) => ({ stage: "walk:" + e.op, path: e.path, code: e.code, message: e.message })));
  }
  const rootReadable = scan.readability.rootReadable;
  const state = !rootReadable ? "failed" : scan.complete ? "ready" : "partial";
  const planHash = sha256Text(JSON.stringify({
    v: PREVIEW_GENERATOR_VERSION, path: normalizePath(p.path), deep, state,
    items: rows.map((r) => [r.path_norm, r.change]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  }));
  repo.updateScanPreview(previewId, {
    state, plan_hash: planHash,
    truncated: scan.truncated ? 1 : 0, complete: scan.complete ? 1 : 0,
    files: scan.files, dirs: scan.dirs, bytes: scan.bytes, error_count: scan.errorCount,
    counts_json: JSON.stringify(counts),
    scan_json: JSON.stringify({ readability: scan.readability, missingProposed: gate.allowed, reasons: gate.reasons }),
    error: rootReadable ? null : "根目录不可读（readdir 失败），本轮结果不可用于判缺",
    finished_at: now(),
  });
  notify({ phase: "commit", files: scan.files, dirs: scan.dirs, bytes: scan.bytes, rows: rows.length });
  log("preview " + previewId + ": state=" + state + " files=" + scan.files + " counts=" + JSON.stringify(counts) + (gate.allowed ? "" : " missingSkipped(" + gate.reasons.join(",") + ")"));
  return { state, counts, gate };
}

export interface ApplyPlan {
  files: string[];
  missingIds: number[];
  items: { id: number; pathNorm: string; change: string }[];
  stale: { id: number; path: string; reason: string }[];
  requested: number;
}

/**
 * 应用前重验：逐条重新 stat，与预览快照（size + mtime）不一致 → stale（不写库，要求重新预览）。
 * 只做元数据核对：size+mtime 一致不等于内容绝对没变（首版不额外哈希，避免大量 IO）。
 */
export function buildApplyPlan(repo: Repo, previewId: number): ApplyPlan {
  const items = repo.scanPreviewItemsForApply(previewId);
  const plan: ApplyPlan = { files: [], missingIds: [], items: [], stale: [], requested: items.length };
  for (const it of items) {
    if (it.change === "missing") {
      // 预览说"资产已消失"：应用前确认它仍然不存在（又出现了 → stale，别再标缺失）
      if (it.path && fileExists(it.path)) {
        plan.stale.push({ id: it.id, path: it.path, reason: "文件又出现了（预览已过期）" });
        continue;
      }
      if (it.asset_id) plan.missingIds.push(Number(it.asset_id));
      plan.items.push({ id: it.id, pathNorm: it.path_norm, change: it.change });
      continue;
    }
    const st = statSafe(it.path);
    if (!st) { plan.stale.push({ id: it.id, path: it.path, reason: "文件已不存在" }); continue; }
    if (Number(it.size) !== st.size || (it.mtime ?? "") !== st.mtime) {
      plan.stale.push({ id: it.id, path: it.path, reason: "文件已变化（size/mtime 与预览不一致）" });
      continue;
    }
    plan.files.push(it.path);
    plan.items.push({ id: it.id, pathNorm: it.path_norm, change: it.change });
  }
  return plan;
}

/**
 * apply 收尾（在 scan job 的 matching 之后调用）：逐条判定"真的登记成功了吗"。
 * 判定依据是**库里的现状**（asset 是否按该路径存在），而不是"跑过没报错"；索引失败由 job 事件里的
 * partial_failures（target=asset:<id>）反查，二者任一不满足即记为失败并允许之后单项重试。
 */
export function finalizeApplyRun(
  repo: Repo,
  payload: { applyRunId: number; previewId: number; applyItems?: { id: number; pathNorm: string; change: string }[]; staleCount?: number },
  visibleFailures: { kind: string; target: string; message: string }[],
  log: (m: string) => void = () => {},
): { applied: number; failed: number; state: string } {
  const failedAssets = new Set(visibleFailures.filter((f) => f.target.startsWith("asset:"))
    .map((f) => Number(f.target.slice("asset:".length))).filter((n) => Number.isFinite(n)));
  let applied = 0; let failed = 0;
  for (const it of payload.applyItems ?? []) {
    if (it.change === "missing") { repo.setScanPreviewItemResult(it.id, true, null); applied++; continue; }
    const a = repo.getAssetByPathNorm(it.pathNorm);
    if (a && !failedAssets.has(a.id)) { repo.setScanPreviewItemResult(it.id, true, null); applied++; }
    else {
      repo.setScanPreviewItemResult(it.id, false, a ? "索引失败（见 job 事件的 partial_failures）" : "登记失败（文件可能在执行期间消失）");
      failed++;
    }
  }
  const counts = repo.scanPreviewItemCounts(payload.previewId);
  const state = applied > 0 && failed === 0 ? "applied" : applied > 0 ? "partially_applied" : "failed";
  repo.updateScanPreview(payload.previewId, { state, finished_at: now() });
  repo.updateScanApplyRun(payload.applyRunId, {
    state: failed === 0 ? "done" : (applied > 0 ? "partial" : "failed"),
    applied, failed, stale: payload.staleCount ?? 0, finished_at: now(), detail_json: JSON.stringify(counts),
  });
  log("apply " + payload.applyRunId + ": applied=" + applied + " failed=" + failed + " stale=" + (payload.staleCount ?? 0) + " -> " + state);
  return { applied, failed, state };
}

function statSafe(p: string): { size: number; mtime: string } | null {
  try { const st = statSync(p); return st.isFile() ? { size: st.size, mtime: st.mtime.toISOString() } : null; } catch { return null; }
}
function fileExists(p: string): boolean { try { return statSync(p).isFile(); } catch { return false; } }
