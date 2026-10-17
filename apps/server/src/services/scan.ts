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
}

/** errors 明细保留上限（坏盘/大目录不至于撑爆内存与日志）；errorCount 仍记真值。 */
const MAX_SCAN_ISSUES = 100;

const errCode = (e: unknown): string | null => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : null;
};

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
 * 有界递归扫描：默认深 6、上限 20000 个候选项，超出置 truncated；每 200 项让出事件循环（不阻塞 HTTP）。
 * M0/P1：readdirSync/statSync 的异常逐条记进 errors/readability，不再静默吞；深度越界与 SKIP_DIR
 * 属于**有意**裁剪（缺失判定侧同样按深度设界），不计为错误。
 */
export async function walkCandidates(rootPath: string, opts: { maxDepth?: number; limit?: number } = {}): Promise<ScanStats> {
  if (!existsSync(rootPath)) throw Object.assign(new Error(`路径不存在: ${rootPath}`), { code: "NOT_FOUND", status: 404 });
  const maxDepth = opts.maxDepth ?? 6;
  const limit = opts.limit ?? 20000;
  const out: ScannedFile[] = [];
  const errors: ScanIssue[] = [];
  const readability: ScanReadability = { rootReadable: false, dirsRead: 0, dirsFailed: 0, entriesStatFailed: 0 };
  let files = 0, dirs = 0, bytes = 0, truncated = false, sinceYield = 0, errorCount = 0;
  const noteError = (path: string, op: ScanIssue["op"], e: unknown): void => {
    errorCount++;
    if (errors.length < MAX_SCAN_ISSUES) errors.push({ path, op, code: errCode(e), message: String((e as Error | null)?.message ?? e) });
  };
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated || depth > maxDepth) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); }
    catch (e) { readability.dirsFailed++; noteError(dir, "readdir", e); return; }
    readability.dirsRead++;
    if (depth === 0) readability.rootReadable = true;
    for (const name of entries) {
      if (truncated) return;
      if (SKIP_DIR.has(name)) continue;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); }
      catch (e) { readability.entriesStatFailed++; noteError(p, "stat", e); continue; }
      if (st.isDirectory()) { dirs++; await walk(p, depth + 1); continue; }
      const ext = extname(name).toLowerCase();
      if (!ARCHIVE_EXT.has(ext)) continue;
      if (out.length >= limit) { truncated = true; return; }
      files++; bytes += st.size;
      out.push({ path: p, size: st.size, mtime: st.mtime.toISOString(), container: ext.slice(1) as ContainerKind, kind: ext === ".unitypackage" ? "unitypackage" : "archive" });
      if (++sinceYield >= 200) { sinceYield = 0; await new Promise<void>((r) => setImmediate(r)); }
    }
  };
  await walk(rootPath, 0);
  return {
    files, dirs, bytes, filesOut: out, truncated,
    errors, errorCount, readability,
    complete: !truncated && errorCount === 0 && readability.rootReadable,
  };
}

export interface ScanPlanItem {
  title: string; sourceSite: "booth" | "local"; sourceItemId: string | null; confidence: number; method: string | null;
  evidence: string[]; assets: { file: ScannedFile }[];
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
    const key = best ? `booth:${best.itemId}` : `local:${normalizePath(f.path)}`;
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

/** 把文件登记为资产（path_norm 去重），返回新建/更新的资产与新增数。 */
export function registerAssets(repo: Repo, rootId: number, path: string, itemId: number, f: ScannedFile, discoveredBy: "scan" | "watch" | "download" | "manual"): { id: number; created: boolean } {
  const r = repo.upsertAsset({
    item_id: itemId, kind: f.kind, container: f.container, path: f.path,
    path_norm: normalizePath(f.path), root_id: rootId, size: f.size, mtime: f.mtime, discovered_by: discoveredBy,
  });
  void extOf; void extractItemIds;
  return { id: r.asset.id, created: r.created };
}