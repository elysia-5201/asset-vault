/**
 * projectusage.ts —— 「Unity 工程引用分析」：判定素材**是不是真的被工程用到**。
 *
 * 与 project_imports（"登记导入"）的区别：登记只说明我们记过一笔，工程里未必真有；
 * 这里拿两侧 GUID 求交：
 *   · 工程侧：递归扫 `<project.path>/Assets`，读每个 `*.meta` 里的 guid（core/unitymeta）；
 *   · 素材侧：`.unitypackage` 的 `<guid>/pathname` 清单 —— 直读 unitypackage_assets；
 *     压缩包里的内层包复用 services/unity.ts 的候选列表 + 落地 + core listUnityPackage
 *     （与"导入 Unity"、"智能查重"走**同一条**解析路径，不存在两套实现互相印证的退化度量）。
 * 命中 → 整表替换 project_refs 一行一个 (project, item, guid)。
 *
 * 时间/内存纪律（沿用 unity.ts 那套）：
 *   · 单包解析 15s 超时（流式解析无法真正中断，超时只是"放弃等待"）；
 *   · 每个资产最多看 3 个内层包；内层包 > 256MB 直接跳过（readArchiveEntry 会整包进内存）；
 *   · guid 索引按 `assetId:size:mtime` 内存缓存（上限 64 条），**空结果不缓存**（偶发读失败不该钉死）；
 *   · 扫描有总预算（默认 45s）：超预算提前返回 remaining=true，已完成的资产照常写库。
 * 先扫"DB 里已有 guid 清单"的资产（纯读表、不解析），再按体积**从小到大**解析压缩包 ——
 * 预算内尽量多覆盖；大包排最后，超预算就下次接着扫。
 */
import type Database from "better-sqlite3";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import type { Repo } from "../db/repo";
import { now } from "../util";
import { listUnityPackage } from "../../../../packages/core/src/unitypackage";
import { isProjectAssetPath, parseMetaGuid } from "../../../../packages/core/src/unitymeta";
import { listUnityPackageCandidates, stageUnityPackage } from "./unity";

/** 单个内层 .unitypackage 的解析超时（与 unity.ts 同口径）。 */
const PACKAGE_TIMEOUT_MS = 15000;
/** 每个资产最多下钻几个内层包（取最大几个；VRChat 素材常见"一个 zip 里 N 个 per-avatar 包"）。 */
const MAX_INNER_PACKAGES = 3;
/** 内层包体积上限：readArchiveEntry 会整包读进内存，超过就跳过（不够准，但不会把服务打爆）。 */
const MAX_INNER_BYTES = 256 * 1024 * 1024;
/** 解析结果上限（.unitypackage 的资产数上限，和索引路径一致）。 */
const MAX_PACKAGE_ASSETS = 20000;
/** 单个 .meta 读取上限。 */
const MAX_META_BYTES = 1024 * 1024;
/** 递归深度上限（相对 Assets/）。 */
const MAX_DEPTH = 12;
/** 文件数上限：超出即 truncated（防被巨大工程拖死）。 */
const MAX_FILES = 200000;
/** 默认总预算。 */
export const DEFAULT_BUDGET_MS = 45000;
/** guid 索引缓存条数上限。 */
const GUID_CACHE_MAX = 64;
/** 扫描时跳过的目录名（大小写不敏感）。 */
const SKIP_DIRS = new Set(["library", "temp", "obj", "logs", ".git", ".svn", "node_modules"]);
const META_RE = /\.meta$/i;

/** 归一化 guid：小写 + 去空白；不是 32 位 hex 返回 null（与 .meta 侧口径一致）。 */
function normGuid(g: unknown): string | null {
  const s = String(g ?? "").trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(s) ? s : null;
}

/**
 * Repo 把 better-sqlite3 句柄收成私有字段，而本文件只允许新增（不改 repo.ts）：
 * 这里做一次受控的向下取用，只为两件 repo 没暴露的事 —— project_refs 的整表替换、
 * 以及"全库资产清单"（逐条 listAssets 是 N+1，工程扫描里不可接受）。
 */
function dbOf(repo: Repo): Database.Database {
  return (repo as unknown as { db: Database.Database }).db;
}

/** 超时包装：解析是流式的，超时只能放弃等待；先给它挂个吞错的订户，免得之后变成 unhandled rejection。 */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  p.catch(() => { /* 超时后仍在跑的解析：忽略它的结果与失败 */ });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("解析超时（" + Math.round(ms / 1000) + "s）：" + what)), ms);
  });
  return Promise.race([p, guard]).finally(() => { if (timer) clearTimeout(timer); });
}

// ---------------------------------------------------------------- 素材侧：GUID 索引

/** guid → 包内资产路径；key = assetId:size:mtime（FIFO 淘汰最旧，空结果不缓存）。 */
const guidCache = new Map<string, Map<string, string>>();

/**
 * 一个资产给出了哪些 GUID（guid → 包内 assetPath）。
 * unitypackage 资产直读 unitypackage_assets（没索引过就现解析一次并落库）；
 * zip/7z/rar 走 unity.ts 的候选列表 → 落地内层包 → core 解析。任何失败都吞掉（返回已拿到的部分）。
 */
export async function guidIndexForAsset(repo: Repo, assetId: number): Promise<Map<string, string>> {
  const a = repo.getAsset(assetId);
  if (!a) return new Map<string, string>();
  const key = assetId + ":" + a.size + ":" + String(a.mtime ?? "");
  const hit = guidCache.get(key);
  if (hit) return hit;

  const map = new Map<string, string>();
  const add = (rows: any[]): void => {
    for (const r of rows) {
      const g = normGuid(r.guid);
      if (g) map.set(g, String(r.assetPath ?? ""));
    }
  };
  try {
    if (a.container === "unitypackage") {
      let rows = repo.getUnityPackageAssets(assetId) as any[];
      if (!rows.length) {
        const listing = await withTimeout(listUnityPackage(a.path, { maxAssets: MAX_PACKAGE_ASSETS }), PACKAGE_TIMEOUT_MS, a.path);
        repo.replaceUnityPackageAssets(assetId, listing.assets);
        rows = repo.getUnityPackageAssets(assetId) as any[];
      }
      add(rows);
    } else if (a.container === "zip" || a.container === "7z" || a.container === "rar") {
      const dir = mkdtempSync(join(tmpdir(), "av-refs-"));
      try {
        const cands = (await listUnityPackageCandidates(repo, a.item_id))
          .packages.filter((c) => c.assetId === assetId).slice(0, MAX_INNER_PACKAGES);
        for (const c of cands) {
          if (c.size > MAX_INNER_BYTES) continue; // 整包进内存，跳过而不是赌内存
          try {
            const staged = await stageUnityPackage(c, dir);
            const listing = await withTimeout(listUnityPackage(staged.path, { maxAssets: MAX_PACKAGE_ASSETS }), PACKAGE_TIMEOUT_MS, staged.path);
            add(listing.assets.map((x: any) => ({ guid: x.guid, assetPath: x.assetPath })));
          } catch { /* 单个内层包失败（网络盘/9p 偶发）不影响其他包 */ }
        }
      } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  } catch { /* 解析失败 → 空索引（不缓存，下次还会再试） */ }

  // 空结果不缓存：偶发失败/还没索引的资产不该被永久钉死成"没有 guid"
  if (map.size > 0) {
    guidCache.set(key, map);
    if (guidCache.size > GUID_CACHE_MAX) {
      const oldest = guidCache.keys().next().value;
      if (oldest !== undefined) guidCache.delete(oldest);
    }
  }
  return map;
}

// ---------------------------------------------------------------- 工程侧：扫 Assets/

interface WalkResult { guidMap: Map<string, string>; files: number; truncated: boolean }

/** 递归扫 `<projectPath>/Assets`，收集 guid → 工程内相对路径（不含 .meta 后缀）。 */
function walkProjectAssets(projectPath: string, deadline: number): WalkResult {
  const guidMap = new Map<string, string>();
  const root = join(projectPath, "Assets");
  let files = 0;
  let truncated = false;
  if (!existsSync(root)) return { guidMap, files, truncated };

  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let sinceCheck = 0;
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) break;
    let entries;
    try { entries = readdirSync(cur.dir, { withFileTypes: true }); } catch { continue; } // 权限/坏挂载：跳过这一个目录，不中断整次扫描
    for (const e of entries) {
      if (sinceCheck++ >= 256) { sinceCheck = 0; if (Date.now() > deadline) { truncated = true; break; } }
      if (files >= MAX_FILES) { truncated = true; break; }
      const full = join(cur.dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
        if (cur.depth + 1 > MAX_DEPTH) { truncated = true; continue; }
        stack.push({ dir: full, depth: cur.depth + 1 });
        continue;
      }
      if (!e.isFile()) continue; // 符号链接等一律不跟，避免环形
      files++;
      if (!META_RE.test(e.name)) continue;
      // 注意：isProjectAssetPath 明确排除 .meta 自身，所以过滤要用**去掉后缀的资源路径**，
      // 而不是 .meta 的路径 —— 否则每个 .meta 都会被自己滤掉（实测踩过：guidCount 恒为 0）。
      const rel = relative(projectPath, full).split(sep).join("/");
      const assetRel = rel.slice(0, -5);
      if (!isProjectAssetPath(assetRel)) continue;
      let text: string;
      try {
        if (statSync(full).size > MAX_META_BYTES) { truncated = true; continue; }
        text = readFileSync(full, "utf8");
      } catch { continue; }
      const guid = parseMetaGuid(text);
      if (guid) guidMap.set(guid, assetRel);
    }
    if (Date.now() > deadline) { truncated = true; break; }
  }
  return { guidMap, files, truncated };
}

/** 从 ProjectSettings/ProjectVersion.txt 取 `m_EditorVersion: 2022.3.22f1`；取不到返回 null。 */
function readProjectVersion(projectPath: string): string | null {
  try {
    const p = join(projectPath, "ProjectSettings", "ProjectVersion.txt");
    if (!existsSync(p)) return null;
    const m = /m_EditorVersion:\s*([^\s\r\n]+)/.exec(readFileSync(p, "utf8"));
    return m && m[1] ? m[1] : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- 扫描

export interface ProjectScanResult {
  projectId: number;
  /** 扫到的文件数（含 .meta；被跳过的目录不计） */
  scannedFiles: number;
  /** 工程侧收集到的 GUID 数 */
  guidCount: number;
  /** 与素材库求交命中的 GUID 数 */
  matchedGuids: number;
  /** 命中的条目数（item） */
  matchedItems: number;
  /** 命中的资产数（asset） */
  matchedAssets: number;
  /** 触到深度/文件数/单文件大小/时间上限，工程侧 GUID 集合可能不全 */
  truncated: boolean;
  /** 预算用尽：还有资产没检查（再调一次会从缓存继续） */
  remaining: boolean;
  /** 耗时（毫秒） */
  ms: number;
}

export interface ScanUsageOptions { budgetMs?: number }

/**
 * 扫一个工程的引用：收集工程侧 GUID → 与素材库求交 → **整表替换**该工程的 project_refs。
 * 顺带把 projects.unity_version（来自 ProjectSettings）与 last_scan_at 补上。
 * 工程不存在 → 抛 { code: "NOT_FOUND", status: 404 }（路由按此回 404）。
 */
export async function scanProjectUsage(repo: Repo, projectId: number, opts: ScanUsageOptions = {}): Promise<ProjectScanResult> {
  const t0 = Date.now();
  const budgetMs = Math.max(1000, Math.floor(opts.budgetMs ?? DEFAULT_BUDGET_MS));
  const deadline = t0 + budgetMs;
  const db = dbOf(repo);

  const project = db.prepare("SELECT id, name, path FROM projects WHERE id=?").get(projectId) as any;
  if (!project) throw Object.assign(new Error("工程不存在：#" + projectId), { code: "NOT_FOUND", status: 404 });
  const projectPath = String(project.path ?? "");

  const walk = walkProjectAssets(projectPath, deadline);
  const guidMap = walk.guidMap;

  const assets = db.prepare("SELECT id, item_id, container, size, mtime FROM assets WHERE status<>'trashed'").all() as any[];
  const cachedIds = new Set<number>((db.prepare("SELECT DISTINCT asset_id FROM unitypackage_assets").all() as any[]).map((r) => Number(r.asset_id)));
  const ordered = assets.slice().sort((a, b) =>
    (Number(cachedIds.has(Number(b.id))) - Number(cachedIds.has(Number(a.id)))) || (Number(a.size) - Number(b.size)));

  const hits: Array<{ itemId: number; assetId: number; guid: string; filePath: string }> = [];
  const matchedGuids = new Set<string>();
  let remaining = false;
  for (const a of ordered) {
    if (Date.now() > deadline) { remaining = true; break; }
    const index = await guidIndexForAsset(repo, Number(a.id));
    if (index.size === 0) continue;
    for (const g of index.keys()) {
      const inProject = guidMap.get(g);
      if (inProject === undefined) continue;
      matchedGuids.add(g);
      hits.push({ itemId: Number(a.item_id), assetId: Number(a.id), guid: g, filePath: inProject });
    }
  }

  const scannedAt = now();
  const replace = db.transaction((rows: typeof hits) => {
    db.prepare("DELETE FROM project_refs WHERE project_id=?").run(projectId);
    const ins = db.prepare("INSERT OR IGNORE INTO project_refs(project_id, item_id, asset_id, guid, file_path, scanned_at) VALUES (?,?,?,?,?,?)");
    for (const h of rows) ins.run(projectId, h.itemId, h.assetId, h.guid, h.filePath, scannedAt);
  });
  replace(hits);

  const ver = readProjectVersion(projectPath);
  if (ver) repo.setProjectUnityVersion(projectId, ver);
  else db.prepare("UPDATE projects SET last_scan_at=? WHERE id=?").run(scannedAt, projectId);

  return {
    projectId,
    scannedFiles: walk.files,
    guidCount: guidMap.size,
    matchedGuids: matchedGuids.size,
    matchedItems: new Set(hits.map((h) => h.itemId)).size,
    matchedAssets: new Set(hits.map((h) => h.assetId)).size,
    truncated: walk.truncated,
    remaining,
    ms: Date.now() - t0,
  };
}

// ---------------------------------------------------------------- 查询

export interface ItemUsage { projectId: number; name: string; path: string; files: number; paths: string[] }

/** 某个条目被哪些工程**真的用到**（每个工程最多给 20 条路径，按路径排序）。 */
export function itemUsage(repo: Repo, itemId: number): ItemUsage[] {
  const db = dbOf(repo);
  const rows = db.prepare(
    "SELECT r.project_id AS projectId, p.name AS name, p.path AS path, r.file_path AS filePath " +
    "FROM project_refs r JOIN projects p ON p.id = r.project_id " +
    "WHERE r.item_id = ? AND r.file_path IS NOT NULL " +
    "ORDER BY r.project_id, r.file_path",
  ).all(itemId) as any[];
  const by = new Map<number, ItemUsage>();
  for (const r of rows) {
    const pid = Number(r.projectId);
    let e = by.get(pid);
    if (!e) { e = { projectId: pid, name: String(r.name ?? ""), path: String(r.path ?? ""), files: 0, paths: [] }; by.set(pid, e); }
    e.files++;
    if (e.paths.length < 20) e.paths.push(String(r.filePath));
  }
  return [...by.values()].sort((a, b) => a.projectId - b.projectId);
}

export interface ProjectUsageItem { itemId: number; title: string; files: number; paths: string[] }

/** 一个工程**真的用到**了哪些素材（按命中文件数降序，同数按 itemId）。 */
export function projectUsage(repo: Repo, projectId: number): ProjectUsageItem[] {
  const db = dbOf(repo);
  const rows = db.prepare(
    "SELECT r.item_id AS itemId, i.title AS title, r.file_path AS filePath " +
    "FROM project_refs r JOIN items i ON i.id = r.item_id " +
    "WHERE r.project_id = ? AND r.file_path IS NOT NULL " +
    "ORDER BY r.item_id, r.file_path",
  ).all(projectId) as any[];
  const by = new Map<number, ProjectUsageItem>();
  for (const r of rows) {
    const iid = Number(r.itemId);
    let e = by.get(iid);
    if (!e) { e = { itemId: iid, title: String(r.title ?? ""), files: 0, paths: [] }; by.set(iid, e); }
    e.files++;
    if (e.paths.length < 20) e.paths.push(String(r.filePath));
  }
  return [...by.values()].sort((a, b) => (b.files - a.files) || (a.itemId - b.itemId));
}
