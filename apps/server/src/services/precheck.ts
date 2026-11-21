/**
 * 导入前只读预检（spec §3.1 / §6.1）。
 *
 * 只回答"这个文件与库里已有什么"：精确重复 / 同商品 / 版本候选 / 配套候选 / 路径冲突。
 * 纯读：只 SELECT 与 stat/流式哈希，不写 items/assets/asset_signatures/scan_preview_*，
 * 不建 job，不调用任何会写库的查重/合并函数。
 *
 * exact 的四条（缺一不可）：
 *   1) 入参本次流式现算；
 *   2) 候选 sha256_state='ok' 且 sha256 非空；
 *   3) 候选磁盘 stat 的 size/mtime 与库内一致（last_verified_at 不是哈希新鲜度证明）；
 *   4) 候选本次重算等于库内 sha256，且等于入参哈希。
 * 预算不足/取消 → 不 exact，降级为 weak（existing_hash_unverified）。
 */
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { AppError, type AssetRow, type ItemRow } from "../../../../packages/core/src/contracts";
import { sha256FileChunked } from "../../../../packages/core/src/hash";
import { identifyFromNames } from "../../../../packages/core/src/identify";
import { parseVersionKey } from "../../../../packages/core/src/dedupe";
import { compareVersions, parseVersion } from "../../../../packages/core/src/version";
import { basename as coreBasename, isSubPath, normalizePath } from "../../../../packages/core/src/pathnorm";
import { walkCandidates } from "./scan";
import type { Repo } from "../db/repo";

// ---------- 输入 ----------

export interface PrecheckSourceHint { site?: string; itemId?: string; title?: string }
export interface PrecheckBudgetInput { maxBytes?: number; maxMs?: number }
export interface PrecheckInput {
  paths: string[];
  source?: PrecheckSourceHint;
  budget?: PrecheckBudgetInput;
}

// ---------- 输出 ----------

export interface PrecheckExactMatch {
  itemId: number; assetId: number; path: string; size: number;
  hashFresh: true; rehashVerified: true;
}
export interface PrecheckSameProductMatch { itemId: number; sourceItemId: string; title: string; status: string }
export type PrecheckVersionRelation = "newer" | "older" | "same" | "unknown";
export interface PrecheckVersionMatch {
  relation: PrecheckVersionRelation;
  incomingKey: string | null;
  existingKey: string | null;
  basis: "filename" | "title";
  /** 文件名/标题只是候选依据，永远不是版本证明。 */
  proven: false;
  existingAssetId: number | null;
}
export interface PrecheckCompanionMatch { markers: string[]; existingAssetId: number | null }
export type PrecheckWeakReason =
  | "existing_hash_stale" | "existing_hash_mismatch" | "existing_hash_unverified" | "name_size_hint";
export interface PrecheckWeakMatch { reason: PrecheckWeakReason; assetId: number | null }
export interface PrecheckPathCollision {
  itemId: number; assetId: number; path: string; pathNorm: string; sameItem: boolean;
}
export interface PrecheckMatch {
  exact: PrecheckExactMatch | null;
  sameProduct: PrecheckSameProductMatch | null;
  version: PrecheckVersionMatch | null;
  companion: PrecheckCompanionMatch | null;
  weak: PrecheckWeakMatch | null;
  pathCollision: PrecheckPathCollision | null;
}
export type PrecheckSummary =
  | "exact" | "version-candidate" | "companion-candidate" | "same-product"
  | "pathCollision" | "weak" | "unknown" | "none";
export interface PrecheckGroup { rootPath: string; rootId: number | null }
export type PrecheckHashState =
  | { state: "ok"; sha256: string }
  | { state: "unknown"; reason: string };
export interface PrecheckResult {
  path: string; pathNorm: string; group: PrecheckGroup;
  size: number | null; mtime: string | null;
  hash: PrecheckHashState;
  match: PrecheckMatch;
  summary: PrecheckSummary;
  warnings: string[];
}
export interface PrecheckBudgetReport {
  maxBytes: number; maxMs: number; usedBytes: number; usedMs: number; truncated: boolean;
}
export interface PrecheckResponse {
  checkedAt: string; budget: PrecheckBudgetReport; results: PrecheckResult[];
}
export interface PrecheckDeps { repo: Repo; log?: (m: string) => void }

// ---------- 常量 ----------

/** 总字节预算默认 4 GiB。 */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
/** 总时间预算默认 20 s。 */
const DEFAULT_MAX_MS = 20_000;
/** 单文件上限 2 GiB。 */
const SINGLE_FILE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** 单次请求 paths 上限。 */
const MAX_PATHS = 200;
/** 目录展开后的文件总数上限。 */
const MAX_EXPANDED_FILES = 500;
/** 目录展开深度（与扫描默认一致）。 */
const WALK_MAX_DEPTH = 6;
/** 祖先目录名最多看几层（商品号可能在任意一层）。 */
const ANCESTOR_DEPTH = 5;

/** 配套标记词（与 related 的噪音词表同源：材质/模型/readme/DLC/套装）。 */
const COMPANION_MARKERS = [
  "material", "materials", "materialpack", "マテリアル", "材質", "材质",
  "texture", "textures", "テクスチャ",
  "model", "モデル", "本体", "prefab",
  "readme", "dlc", "set", "セット", "付属", "対応",
];

// ---------- 内部状态 ----------

interface BudgetState {
  maxBytes: number; maxMs: number; startedAt: number; usedBytes: number; truncated: boolean;
}
interface ExpandedFile {
  path: string; rootPath: string; size: number | null; mtime: string | null; statError: string | null;
}

// ---------- 入口 ----------

export async function precheckPaths(
  deps: PrecheckDeps,
  input: PrecheckInput,
  signal?: AbortSignal,
): Promise<PrecheckResponse> {
  const paths = validateInput(input);
  const budget: BudgetState = {
    maxBytes: clampBudget(input.budget?.maxBytes, DEFAULT_MAX_BYTES, "maxBytes"),
    maxMs: clampBudget(input.budget?.maxMs, DEFAULT_MAX_MS, "maxMs"),
    startedAt: Date.now(),
    usedBytes: 0,
    truncated: false,
  };
  const files = await expandInputs(paths, budget, signal, deps.log);
  const results: PrecheckResult[] = [];
  for (const f of files) results.push(await precheckOne(deps, f, input.source, budget, signal));
  return {
    checkedAt: new Date().toISOString(),
    budget: {
      maxBytes: budget.maxBytes,
      maxMs: budget.maxMs,
      usedBytes: budget.usedBytes,
      usedMs: Date.now() - budget.startedAt,
      truncated: budget.truncated,
    },
    results,
  };
}

// ---------- 输入校验 ----------

function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

function validateInput(input: PrecheckInput): string[] {
  if (!input || !Array.isArray(input.paths)) {
    throw new AppError("INVALID_INPUT", "paths 必须是数组", 400);
  }
  if (input.paths.length < 1 || input.paths.length > MAX_PATHS) {
    throw new AppError("INVALID_INPUT", "paths 数量必须在 1.." + MAX_PATHS, 400);
  }
  for (const p of input.paths) {
    if (typeof p !== "string" || p.trim() === "") {
      throw new AppError("INVALID_INPUT", "paths 含空路径", 400);
    }
    if (!isAbsolutePath(p)) {
      throw new AppError("INVALID_INPUT", "paths 必须是绝对路径: " + p, 400);
    }
  }
  return input.paths;
}

function clampBudget(v: number | undefined, fallback: number, label: string): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new AppError("INVALID_INPUT", "budget." + label + " 非法", 400);
  }
  return Math.min(Math.floor(v), fallback);
}

// ---------- 展开 ----------

async function expandInputs(
  paths: string[],
  budget: BudgetState,
  signal: AbortSignal | undefined,
  log: ((m: string) => void) | undefined,
): Promise<ExpandedFile[]> {
  const out: ExpandedFile[] = [];
  for (const p of paths) {
    if (out.length >= MAX_EXPANDED_FILES) { budget.truncated = true; break; }
    let st;
    try { st = statSync(p); }
    catch {
      out.push({ path: p, rootPath: dirname(p), size: null, mtime: null, statError: "unreadable" });
      continue;
    }
    if (!st.isDirectory()) {
      out.push({ path: p, rootPath: dirname(p), size: st.size, mtime: st.mtime.toISOString(), statError: null });
      continue;
    }
    const remaining = MAX_EXPANDED_FILES - out.length;
    try {
      const stats = await walkCandidates(p, { maxDepth: WALK_MAX_DEPTH, limit: remaining, signal });
      for (const f of stats.filesOut) {
        out.push({ path: f.path, rootPath: p, size: f.size, mtime: f.mtime, statError: null });
      }
      if (stats.truncated) budget.truncated = true;
    } catch (e) {
      budget.truncated = true;
      log?.("precheck: 目录展开失败 " + p + ": " + String((e as Error)?.message ?? e));
    }
  }
  return out;
}

// ---------- 预算内哈希 ----------

async function hashWithinBudget(
  file: string,
  size: number,
  budget: BudgetState,
  signal: AbortSignal | undefined,
): Promise<PrecheckHashState> {
  if (signal?.aborted) return { state: "unknown", reason: "cancelled" };
  if (size > SINGLE_FILE_MAX_BYTES) return { state: "unknown", reason: "too_large" };
  if (budget.usedBytes + size > budget.maxBytes) {
    budget.truncated = true;
    return { state: "unknown", reason: "budget_exceeded" };
  }
  const elapsed = Date.now() - budget.startedAt;
  if (elapsed >= budget.maxMs) {
    budget.truncated = true;
    return { state: "unknown", reason: "budget_exceeded" };
  }
  try {
    const r = await sha256FileChunked(file, { signal, timeoutMs: Math.max(1, budget.maxMs - elapsed) });
    budget.usedBytes += r.bytes;
    return { state: "ok", sha256: r.sha256 };
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code === "CANCELLED") return { state: "unknown", reason: "cancelled" };
    if (code === "TIMEOUT") {
      budget.truncated = true;
      return { state: "unknown", reason: "budget_exceeded" };
    }
    return { state: "unknown", reason: "unreadable" };
  }
}

// ---------- 单文件 ----------

async function precheckOne(
  deps: PrecheckDeps,
  f: ExpandedFile,
  source: PrecheckSourceHint | undefined,
  budget: BudgetState,
  signal: AbortSignal | undefined,
): Promise<PrecheckResult> {
  const repo = deps.repo;
  const pathNorm = normalizePath(f.path);
  const group: PrecheckGroup = { rootPath: f.rootPath, rootId: resolveRootId(repo, pathNorm) };
  let size = f.size;
  let mtime = f.mtime;
  if (size === null || mtime === null) {
    try {
      const st = statSync(f.path);
      if (!st.isFile()) throw new Error("not a regular file");
      size = st.size;
      mtime = st.mtime.toISOString();
    } catch {
      size = null;
      mtime = null;
    }
  }
  const hash: PrecheckHashState = size === null
    ? { state: "unknown", reason: f.statError ?? "unreadable" }
    : await hashWithinBudget(f.path, size, budget, signal);

  const match: PrecheckMatch = {
    exact: null, sameProduct: null, version: null, companion: null, weak: null, pathCollision: null,
  };
  try {
    const sameProduct = findSameProduct(repo, f.path);
    if (sameProduct) {
      match.sameProduct = {
        itemId: sameProduct.item.id,
        sourceItemId: sameProduct.sourceItemId,
        title: sameProduct.item.title,
        status: sameProduct.item.status,
      };
    }

    const collisionRow = findAssetByPathNorm(repo, f.path, pathNorm);
    if (collisionRow) {
      match.pathCollision = {
        itemId: collisionRow.item_id,
        assetId: collisionRow.id,
        path: collisionRow.path,
        pathNorm: collisionRow.path_norm,
        sameItem: sameProduct ? collisionRow.item_id === sameProduct.item.id : false,
      };
    }

    const exact = await evaluateExact(repo, hash, collisionRow, budget, signal);
    match.exact = exact.exact;
    match.weak = exact.weak;

    if (sameProduct) {
      match.version = evaluateVersion(repo, sameProduct.item, f.path, source?.title);
      // 配套只在"不构成版本候选"时计算：没有版本字段，或版本关系不可解析（unknown）。
      if (!match.version || match.version.relation === "unknown") {
        const markers = companionMarkers(f.path);
        if (markers.length > 0) match.companion = { markers, existingAssetId: null };
      }
    }

    if (!match.weak && hash.state === "unknown" && size !== null) {
      match.weak = nameSizeHint(repo, f.path, size);
    }
  } catch (e) {
    deps.log?.("precheck: 单文件匹配失败 " + f.path + ": " + String((e as Error)?.message ?? e));
  }

  const warnings: string[] = [];
  if (hash.state === "unknown") warnings.push("hash_unknown:" + hash.reason);
  if (match.weak?.reason === "name_size_hint") warnings.push("name_size_hint: 同名同尺寸，不是精确重复");

  return {
    path: f.path,
    pathNorm,
    group,
    size,
    mtime,
    hash,
    match,
    summary: summaryOf(match, hash),
    warnings,
  };
}

// ---------- 匹配 ----------

function summaryOf(match: PrecheckMatch, hash: PrecheckHashState): PrecheckSummary {
  if (match.exact) return "exact";
  // relation="unknown" 只是"有版本字段但不可解析"，不是版本候选（spec §3.3/§3.4）。
  if (match.version && match.version.relation !== "unknown") return "version-candidate";
  if (match.companion) return "companion-candidate";
  if (match.sameProduct) return "same-product";
  if (match.pathCollision) return "pathCollision";
  if (match.weak) return "weak";
  if (hash.state === "unknown") return "unknown";
  return "none";
}

/**
 * path_norm 身份查询：先走 repo 的精确索引。
 * 仅当入参归一化后与原串不同（说明库里可能存了未归一化的历史行）才做一次
 * 大小写不敏感回退；归一化未改变时精确未命中就是真的没有，不做全表扫描。
 * 本服务只读，不修数据。
 */
function findAssetByPathNorm(repo: Repo, rawPath: string, pathNorm: string): AssetRow | null {
  const exact = repo.getAssetByPathNorm(pathNorm);
  if (exact && exact.status !== "trashed") return exact;
  if (pathNorm === rawPath) return null;
  const row = repo.connection
    .prepare("SELECT * FROM assets WHERE status<>'trashed' AND (path_norm=? COLLATE NOCASE OR path_norm=? COLLATE NOCASE) ORDER BY id LIMIT 1")
    .get(pathNorm, rawPath) as AssetRow | undefined;
  return row ?? null;
}

function resolveRootId(repo: Repo, pathNorm: string): number | null {
  const roots = repo.connection.prepare("SELECT id, path_norm FROM library_roots").all() as { id: number; path_norm: string }[];
  let best: { id: number; len: number } | null = null;
  for (const r of roots) {
    if (!r.path_norm) continue;
    if (!isSubPath(pathNorm, r.path_norm)) continue;
    if (!best || r.path_norm.length > best.len) best = { id: r.id, len: r.path_norm.length };
  }
  return best ? best.id : null;
}

function ancestorNames(p: string): string[] {
  const names: string[] = [];
  let cur = p;
  for (let i = 0; i < ANCESTOR_DEPTH; i++) {
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
    const b = coreBasename(cur);
    if (b && b !== "/" && !/^[a-zA-Z]:$/.test(b)) names.push(b);
  }
  return names;
}

function findSameProduct(repo: Repo, path: string): { item: ItemRow; sourceItemId: string } | null {
  const names = [coreBasename(path), ...ancestorNames(path)];
  const best = identifyFromNames(names).best;
  if (!best) return null;
  const row = repo.connection
    .prepare("SELECT * FROM items WHERE source_site='booth' AND source_item_id=? LIMIT 1")
    .get(best.itemId) as ItemRow | undefined;
  if (!row) return null;
  return { item: row, sourceItemId: best.itemId };
}

function versionKeyOfAsset(repo: Repo, asset: AssetRow, itemTitle: string): string | null {
  const sig = repo.connection
    .prepare("SELECT version_key FROM asset_signatures WHERE asset_id=?")
    .get(asset.id) as { version_key: string | null } | undefined;
  if (sig && sig.version_key) return sig.version_key;
  const fromName = parseVersionKey(coreBasename(asset.path));
  if (fromName) return fromName;
  return parseVersionKey(itemTitle);
}

function evaluateVersion(
  repo: Repo,
  item: ItemRow,
  incomingPath: string,
  sourceTitle: string | undefined,
): PrecheckVersionMatch | null {
  const fromName = parseVersionKey(coreBasename(incomingPath));
  const incomingKey = fromName ?? (sourceTitle ? parseVersionKey(sourceTitle) : null);
  const basis: "filename" | "title" = fromName ? "filename" : "title";
  const assets = repo.connection
    .prepare("SELECT * FROM assets WHERE item_id=? AND status<>'trashed' ORDER BY id")
    .all(item.id) as AssetRow[];
  if (assets.length === 0) return null;

  let best: { asset: AssetRow; key: string } | null = null;
  for (const a of assets) {
    const key = versionKeyOfAsset(repo, a, item.title);
    if (!key || !parseVersion(key)) continue;
    if (!best || compareVersions(key, best.key) > 0) best = { asset: a, key };
  }
  if (!best) {
    const latest = [...assets].sort((x, y) =>
      String(y.first_seen ?? "").localeCompare(String(x.first_seen ?? "")) || y.id - x.id)[0];
    return {
      relation: "unknown", incomingKey, existingKey: null, basis, proven: false,
      existingAssetId: latest ? latest.id : null,
    };
  }
  if (!incomingKey || !parseVersion(incomingKey)) {
    return {
      relation: "unknown", incomingKey, existingKey: best.key, basis, proven: false,
      existingAssetId: best.asset.id,
    };
  }
  const cmp = compareVersions(incomingKey, best.key);
  const relation: PrecheckVersionRelation = cmp > 0 ? "newer" : cmp < 0 ? "older" : "same";
  return {
    relation, incomingKey, existingKey: best.key, basis, proven: false,
    existingAssetId: best.asset.id,
  };
}

/** 按"独立片段"命中（与 related 的噪音词表口径一致），避免 "asset" 命中 "set" 这类子串误报。 */
function companionMarkers(path: string): string[] {
  const name = coreBasename(path).normalize("NFKC").toLowerCase();
  const segments = new Set(name.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  return COMPANION_MARKERS.filter((m) => segments.has(m));
}

function nameSizeHint(repo: Repo, path: string, size: number): PrecheckWeakMatch | null {
  const name = coreBasename(path);
  const rows = repo.connection
    .prepare("SELECT * FROM assets WHERE size=? AND status<>'trashed' ORDER BY id")
    .all(size) as AssetRow[];
  const hit = rows.find((a) => coreBasename(a.path) === name);
  return hit ? { reason: "name_size_hint", assetId: hit.id } : null;
}

async function evaluateExact(
  repo: Repo,
  hash: PrecheckHashState,
  collision: AssetRow | null,
  budget: BudgetState,
  signal: AbortSignal | undefined,
): Promise<{ exact: PrecheckExactMatch | null; weak: PrecheckWeakMatch | null }> {
  if (hash.state !== "ok") return { exact: null, weak: null };
  const incoming = hash.sha256;
  const candidates: AssetRow[] = [];
  const push = (a: AssetRow): void => { if (!candidates.some((c) => c.id === a.id)) candidates.push(a); };
  if (collision) push(collision);
  const rows = repo.connection
    .prepare("SELECT * FROM assets WHERE sha256=? AND sha256_state='ok' AND status<>'trashed' ORDER BY id")
    .all(incoming) as AssetRow[];
  for (const r of rows) push(r);

  let weak: PrecheckWeakMatch | null = null;
  for (const c of candidates) {
    if (c.sha256_state !== "ok" || !c.sha256) continue;
    let st;
    try { st = statSync(c.path); }
    catch {
      weak = weak ?? { reason: "existing_hash_stale", assetId: c.id };
      continue;
    }
    if (!st.isFile() || Number(st.size) !== Number(c.size) || st.mtime.toISOString() !== String(c.mtime ?? "")) {
      weak = weak ?? { reason: "existing_hash_stale", assetId: c.id };
      continue;
    }
    const re = await hashWithinBudget(c.path, st.size, budget, signal);
    if (re.state !== "ok") {
      weak = weak ?? { reason: "existing_hash_unverified", assetId: c.id };
      continue;
    }
    if (re.sha256 !== c.sha256 || re.sha256 !== incoming) {
      weak = weak ?? { reason: "existing_hash_mismatch", assetId: c.id };
      continue;
    }
    return {
      exact: {
        itemId: c.item_id, assetId: c.id, path: c.path, size: Number(c.size),
        hashFresh: true, rehashVerified: true,
      },
      weak: null,
    };
  }
  return { exact: null, weak };
}
