/**
 * 工作台后端：容器/资源单元识别、关系建议、导入计划与执行（task-38，schema v8）。
 *
 * 硬约束（lead 验收口径）：
 *  - mixed .unitypackage 的 plan/execute 永远引用**原始整包**，绝不生成筛选包/临时拆包；
 *  - 每个单元在 import_run_items 里有独立状态，互不覆盖；
 *  - 指纹变化 → plan blocked / execute 拒绝（FINGERPRINT_CHANGED），绝不按旧快照导入；
 *  - Unity 调用返回只算 import_command_completed；verified/partial_success 是**另外**的验证结论。
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listArchive, readArchiveEntry } from "../../../../packages/core/src/archive/list";
import {
  detectUnitAvatars, decidePolicy, relationCandidates,
  type AvatarLite, type AvatarEvidence, type StructurePolicy, type StructureUnit,
} from "../../../../packages/core/src/structure";
import { normalizePath } from "../../../../packages/core/src/pathnorm";
import { listUnityPackage } from "../../../../packages/core/src/unitypackage";
import { scanPaths, RISK_SCANNER_VERSION, type RiskHit, type RiskState, type RiskScanResult } from "../../../../packages/core/src/risk";
import type { Repo } from "../db/repo";
import {
  UnityMcp, unityEditorInfo, importPackagesIntoUnity,
  readUnityConsole, clearUnityConsole, sleep, baseName, unitySessionHealthy,
} from "./unity";

const IMPORTABLE_POLICIES = new Set<StructurePolicy>(["single_unitypackage", "mixed_unitypackage"]);

function appErr(code: string, message: string, status: number): Error {
  return Object.assign(new Error(message), { code, status });
}

export interface AnalyzeItemResult {
  itemId: number;
  assets: number;
  units: number;
  relations: number;
  errors: { assetId: number; path: string; message: string }[];
}

interface UnitRowInput {
  relPath: string; format: string; kind: string; name: string; size: number; fingerprint: string | null;
  policy: StructurePolicy; importable: boolean; parseState: string; parseError?: string | null;
  avatars?: AvatarEvidence[]; evidence?: unknown;
}

function fingerprintOf(asset: { size?: number | null; mtime?: string | null; sha256?: string | null }, size?: number): string {
  return `${Number(size ?? asset.size ?? 0)}:${String(asset.mtime ?? "")}:${String(asset.sha256 ?? "").slice(0, 8)}`;
}

function parseStateOf(asset: { index_state?: string | null }): "ok" | "partial" | "failed" {
  const s = String(asset.index_state ?? "pending");
  return s === "failed" ? "failed" : s === "done" ? "ok" : "partial";
}

function evidenceCount(ev: AvatarEvidence[]): number {
  return new Set(ev.filter((e) => e.level === "confirmed" || e.level === "probable").map((e) => e.avatarId)).size;
}

/** 嵌套容器发现上限（task-45：depth=3 / archives=32 / 45s / 累计解压 512MB）。 */
const NESTED_MAX_DEPTH = 3;
const NESTED_MAX_ARCHIVES = 32;
const NESTED_MAX_ENTRIES = 5000;
const NESTED_MAX_BYTES = 512 * 1024 * 1024;
const NESTED_TIME_BUDGET_MS = 45_000;
const ARCHIVE_EXT_RE = /\.(zip|7z|rar)$/i;

interface NestedDiscovery {
  /** 内层 upkg 单元（rel_path='outer::inner[:...]'） */
  packages: { relPath: string; size: number }[];
  /** 读不了/超限/深度超限的嵌套容器（落 limited/failed 单元） */
  limited: { relPath: string; reason: string; state: "limited" | "failed" }[];
}

/**
 * 在外层压缩包里递归发现 .unitypackage（task-45：depth=3）。
 * 外层 archive_entries 的 zip/7z/rar → 解出临时文件 → listArchive，递归到第 3 层容器；
 * 能展开的内层 zip 不产生 limited 占位；只有超预算/超深度/读失败才留 limited 证据。
 */
async function discoverNestedContainers(asset: any, outerArchives: { entryPath: string; size: number }[]): Promise<NestedDiscovery> {
  const out: NestedDiscovery = { packages: [], limited: [] };
  const seenPkg = new Set<string>();
  const seenLimited = new Set<string>();
  const started = Date.now();
  let opened = 0;
  let bytes = 0;
  const addLimited = (relPath: string, reason: string, state: "limited" | "failed") => {
    if (seenLimited.has(relPath)) return;
    seenLimited.add(relPath);
    out.limited.push({ relPath, reason, state });
  };

  /** 展开一个压缩包条目；level=该条目所在容器层级（外层条目=1，可展开到 3）。 */
  const expand = async (containerFile: string, parts: string[], size: number, level: number): Promise<void> => {
    const rel = parts.join("::");
    if (opened >= NESTED_MAX_ARCHIVES) return addLimited(rel, "嵌套容器数超过上限 " + NESTED_MAX_ARCHIVES, "limited");
    if (Date.now() - started > NESTED_TIME_BUDGET_MS) return addLimited(rel, "嵌套发现超过时间预算 " + NESTED_TIME_BUDGET_MS + "ms", "limited");
    if (bytes + size > NESTED_MAX_BYTES) return addLimited(rel, "累计解压超过 " + Math.round(NESTED_MAX_BYTES / 1024 / 1024) + "MB 上限", "limited");
    opened++;
    let dir: string | null = null;
    try {
      const cap = Math.max(1, NESTED_MAX_BYTES - bytes);
      const buf = await readArchiveEntry(containerFile, parts[parts.length - 1], cap);
      bytes += buf.length;
      dir = mkdtempSync(join(tmpdir(), "av-nested-"));
      const tmp = join(dir, "inner" + (ARCHIVE_EXT_RE.exec(parts[parts.length - 1])?.[0] ?? ".zip"));
      writeFileSync(tmp, buf);
      const listing = await listArchive(tmp, { maxEntries: NESTED_MAX_ENTRIES });
      for (const e of listing.entries) {
        if (e.isDir) continue;
        const childParts = [...parts, e.path];
        const childRel = childParts.join("::");
        if (/\.unitypackage$/i.test(e.path)) {
          if (!seenPkg.has(childRel)) { seenPkg.add(childRel); out.packages.push({ relPath: childRel, size: Number(e.size) || 0 }); }
          continue;
        }
        if (ARCHIVE_EXT_RE.test(e.path)) {
          if (level < NESTED_MAX_DEPTH) await expand(tmp, childParts, Number(e.size) || 0, level + 1);
          else addLimited(childRel, "嵌套深度超过 " + NESTED_MAX_DEPTH + " 层，未展开", "limited");
        }
      }
      if (listing.truncated) addLimited(rel, "内层条目数超过上限 " + NESTED_MAX_ENTRIES, "limited");
    } catch (e) {
      addLimited(rel, "无法读取内层容器：" + ((e as Error)?.message ?? String(e)).slice(0, 200), "failed");
    } finally {
      if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  };

  for (const entry of outerArchives) await expand(String(asset.path), [entry.entryPath], Number(entry.size) || 0, 1);
  return out;
}

/** task-51：统一 run_item 状态机（unknown/cancelled 为终态；unknown 不自动重试）。 */
export type RunItemStatus = "queued" | "prechecking" | "blocked" | "importing" | "import_command_completed" | "verifying" | "verified" | "partial_success" | "failed" | "unknown" | "cancelled";
const RUN_ITEM_TRANSITIONS: Record<string, string[]> = {
  pending: ["queued", "blocked", "importing", "failed", "cancelled"],
  queued: ["prechecking", "blocked", "importing", "failed", "cancelled"],
  prechecking: ["blocked", "importing", "failed", "cancelled"],
  blocked: ["queued", "cancelled"],
  importing: ["import_command_completed", "failed", "unknown", "cancelled"],
  import_command_completed: ["verifying", "failed", "unknown", "cancelled"],
  verifying: ["verified", "partial_success", "failed", "unknown", "cancelled"],
  verified: [],
  partial_success: ["queued", "cancelled"],
  failed: ["queued"],
  unknown: [],
  cancelled: [],
};
export function canTransitionRunItem(from: string, to: string): boolean {
  if (from === to) return true;
  return (RUN_ITEM_TRANSITIONS[from] ?? []).includes(to);
}
/** 带状态机校验的 run_item 迁移；非法迁移抛 INVALID_TRANSITION（绝不静默写坏状态）。 */
export function transitionRunItem(repo: Repo, id: number, to: RunItemStatus, patch: { started_at?: string | null; finished_at?: string | null; error?: string | null; detail_json?: string | null } = {}): any {
  const row = repo.getImportRunItem(id);
  const from = String(row?.status ?? "pending");
  if (!canTransitionRunItem(from, to)) throw appErr("INVALID_TRANSITION", "run_item " + id + " 不允许 " + from + " → " + to, 409);
  return repo.updateImportRunItem(id, { ...patch, status: to });
}

/** task-45：按需解析 unitypackage 内容的预算（每项 ≤64 包 / 累计 512MB / 45s / 1 万条资产）。 */
const MAX_PACKAGE_PARSES = 64;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const PACKAGE_PARSE_BUDGET_MS = 45_000;
const MAX_PACKAGE_ASSETS = 10_000;

interface PackageBudget { packages: number; bytes: number; started: number }
type PackagePathsResult = { ok: true; paths: string[]; guids: string[] } | { ok: false; state: "limited" | "failed"; error: string };
interface AnalyzeCtx { cache: Map<string, PackagePathsResult>; budget: PackageBudget }

/**
 * 把压缩包条目按 'outer::inner::...' 递归解出最终 .unitypackage 文件（返回磁盘路径）。
 * 调用方负责删除 dir（解析场景）；执行场景保留到 Unity 读完后由 staging 目录清理。
 */
async function extractNestedToFile(sourcePath: string, parts: string[], dir: string): Promise<string> {
  let current = sourcePath;
  for (let i = 0; i < parts.length; i++) {
    const buf = await readArchiveEntry(current, parts[i], MAX_PACKAGE_BYTES);
    const last = i === parts.length - 1;
    const out = join(dir, last ? "pkg.unitypackage" : "lvl" + i + (ARCHIVE_EXT_RE.exec(parts[i])?.[0] ?? ".zip"));
    writeFileSync(out, buf);
    current = out;
  }
  return current;
}

/** 执行端 staging：direct 直接用原文件；压缩包条目（含 depth3 outer::inner::pkg）递归解到 staging 目录。 */
export async function stageUnitPackage(asset: any, relPath: string, stagingDir: string, key: string): Promise<string> {
  const direct = String(asset.kind) === "unitypackage" || String(asset.container) === "unitypackage";
  if (direct) return String(asset.path);
  mkdirSync(stagingDir, { recursive: true });
  const dir = mkdtempSync(join(stagingDir, "unit-" + String(key).replace(/[^\w.-]+/g, "_") + "-"));
  return extractNestedToFile(String(asset.path), String(relPath).split("::").filter(Boolean), dir);
}

/**
 * 读出一个单元的 unitypackage 内 asset_path 列表（含 outer::inner 嵌套）。
 * - 直连 .unitypackage：直接读文件；
 * - 压缩包条目（rel_path 无 ::）：readArchiveEntry 解出 upkg；
 * - outer::inner：先解外层容器，再读内层 upkg。
 * 失败/超限返回 state，由调用方落 limited/failed 单元（不伪造 mixed/证据）；临时文件 finally 删除。
 */
async function readPackageAssetPaths(asset: any, relPath: string, ctx: AnalyzeCtx): Promise<PackagePathsResult> {
  const key = asset.id + "|" + relPath;
  const hit = ctx.cache.get(key);
  if (hit) return hit;
  const fail = (state: "limited" | "failed", error: string): PackagePathsResult => {
    const r: PackagePathsResult = { ok: false, state, error };
    ctx.cache.set(key, r);
    return r;
  };
  if (ctx.budget.packages >= MAX_PACKAGE_PARSES) return fail("limited", "单元解析包数超过上限 " + MAX_PACKAGE_PARSES);
  if (Date.now() - ctx.budget.started > PACKAGE_PARSE_BUDGET_MS) return fail("limited", "单元解析超过时间预算 " + PACKAGE_PARSE_BUDGET_MS + "ms");
  const direct = String(asset.kind) === "unitypackage" || String(asset.container) === "unitypackage";
  let dir: string | null = null;
  let target = String(asset.path);
  let bytes = 0;
  try {
    if (!direct) {
      const parts = relPath.split("::").filter(Boolean);
      dir = mkdtempSync(join(tmpdir(), "av-upkg-"));
      if (parts.length === 0) return fail("limited", "空嵌套路径，无法按需解析");
      target = await extractNestedToFile(String(asset.path), parts, dir);
    }
    const listing = await listUnityPackage(target, { maxAssets: MAX_PACKAGE_ASSETS, maxTotalBytes: MAX_PACKAGE_BYTES - bytes });
    const paths = (listing.assets ?? []).map((a) => String(a.assetPath)).filter(Boolean);
    const guids = (listing.assets ?? []).map((a) => String(a.guid)).filter(Boolean);
    ctx.budget.packages++;
    ctx.budget.bytes += bytes;
    const ok: PackagePathsResult = { ok: true, paths, guids };
    ctx.cache.set(key, ok);
    return ok;
  } catch (e) {
    const code = String((e as any)?.code ?? "");
    const msg = String((e as any)?.message ?? e);
    const limited = code === "BYTES" || code === "ENTRIES" || /too many|exceed|limit|truncat/i.test(msg);
    return fail(limited ? "limited" : "failed", "解析 unitypackage 内容失败：" + msg.slice(0, 200));
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

/** 单个 asset → 单元集（直接条目读 DB；嵌套容器需要 IO，await discoverNestedContainers）。 */
function parseFailUnit(relPath: string, name: string, size: number, fingerprint: string, r: { state: string; error: string }): UnitRowInput {
  return {
    relPath, format: "unitypackage", kind: "unitypackage", name, size, fingerprint,
    policy: "unknown_structure", importable: false, parseState: r.state, parseError: r.error,
    avatars: [], evidence: { reason: r.error, contentParsed: false },
  };
}

async function unitsOfAsset(repo: Repo, asset: any, avatars: AvatarLite[], itemAvatarIds: number[], ctx: AnalyzeCtx): Promise<UnitRowInput[]> {
  const container = String(asset.container ?? "");
  const kind = String(asset.kind ?? "");
  const parseState = parseStateOf(asset);
  const parseError = asset.index_error ?? null;
  const name = baseName(asset.path);
  const directUpkg = kind === "unitypackage" || container === "unitypackage";
  const archive = ["zip", "7z", "rar"].includes(container) || kind === "archive";
  const fp = fingerprintOf(asset);

  if (directUpkg) {
    let paths = (repo.getUnityPackageAssets(asset.id) as any[]).map((r) => String(r.assetPath));
    if (paths.length === 0) {
      // task-44：没有索引结果时按需解析包内 asset_path（不能只看文件名判 mixed）。
      const parsed = await readPackageAssetPaths(asset, name, ctx);
      if (!parsed.ok) return [parseFailUnit(name, name, Number(asset.size) || 0, fp, parsed)];
      paths = parsed.paths;
    }
    const ev = detectUnitAvatars([name, ...paths], avatars, itemAvatarIds);
    // 包级解析成功即视为 ok（外层资产 index_state=partial 只说明外层没扫完，不代表这个 upkg 不可判定）
    const unitParseState = paths.length > 0 ? "ok" : parseState;
    const d = decidePolicy({ container: container || "unitypackage", kind: "unitypackage", innerUnitypackagePaths: [name], mixedAvatarCount: evidenceCount(ev), parseState: unitParseState });
    return [{
      relPath: name, format: "unitypackage", kind: "unitypackage", name, size: Number(asset.size) || 0, fingerprint: fp,
      policy: d.policy, importable: IMPORTABLE_POLICIES.has(d.policy), parseState: unitParseState, parseError,
      avatars: ev, evidence: { reason: d.reason, contentParsed: true, packagePaths: paths.length },
    }];
  }

  if (archive) {
    const entries = repo.listUnitypackageEntries(asset.id);
    // task-42：递归发现嵌套容器里的 unitypackage（depth ≤2，rel_path='outer::inner'）
    const nestedArchives = (repo.getArchiveEntries(asset.id) as any[])
      .filter((e) => !e.isDir && ARCHIVE_EXT_RE.test(String(e.path)))
      .map((e) => ({ entryPath: String(e.path), size: Number(e.size) || 0 }));
    const nested: NestedDiscovery = nestedArchives.length
      ? await discoverNestedContainers(asset, nestedArchives)
      : { packages: [], limited: [] };
    const limitedUnits: UnitRowInput[] = nested.limited.map((l) => ({
      relPath: l.relPath, format: "archive", kind: "container", name: baseName(l.relPath), size: 0,
      fingerprint: fp, policy: "unknown_structure", importable: false, parseState: l.state, parseError: l.reason,
      avatars: [], evidence: { reason: l.reason },
    }));
    const pkgRows = [
      ...entries.map((e) => ({ relPath: e.entryPath, size: Number(e.size) || 0 })),
      ...nested.packages.map((p) => ({ relPath: p.relPath, size: p.size })),
    ];
    if (pkgRows.length === 0) {
      const d = decidePolicy({ container, kind: "archive", innerUnitypackagePaths: [], mixedAvatarCount: 0, parseState });
      return [{
        relPath: "", format: container || "archive", kind: "container", name, size: Number(asset.size) || 0, fingerprint: fp,
        policy: d.policy, importable: false, parseState, parseError,
        avatars: [], evidence: { reason: d.reason },
      }, ...limitedUnits];
    }
    const units: UnitRowInput[] = [];
    for (const e of pkgRows) {
      // task-44：每个 upkg 单元（含 outer::inner）按需解析 asset_path；失败 → limited/failed，不伪造。
      const parsed = await readPackageAssetPaths(asset, e.relPath, ctx);
      if (!parsed.ok) { units.push(parseFailUnit(e.relPath, baseName(e.relPath), e.size, fingerprintOf(asset, e.size), parsed)); continue; }
      const ev = detectUnitAvatars([e.relPath, name, ...parsed.paths], avatars, itemAvatarIds);
      const unitParseState = parsed.paths.length > 0 ? "ok" : parseState;
      const d = pkgRows.length > 1
        ? decidePolicy({ container, kind: "unitypackage", innerUnitypackagePaths: [e.relPath], mixedAvatarCount: evidenceCount(ev), parseState: unitParseState })
        : decidePolicy({ container, kind: "archive", innerUnitypackagePaths: [e.relPath], mixedAvatarCount: evidenceCount(ev), parseState: unitParseState });
      units.push({
        relPath: e.relPath, format: "unitypackage", kind: "unitypackage", name: baseName(e.relPath), size: e.size,
        fingerprint: fingerprintOf(asset, e.size), policy: d.policy, importable: IMPORTABLE_POLICIES.has(d.policy),
        parseState: unitParseState, parseError, avatars: ev,
        evidence: { reason: d.reason, nested: e.relPath.includes("::"), contentParsed: true, packagePaths: parsed.paths.length },
      });
    }
    if (pkgRows.length > 1) {
      const all = new Set<number>(); for (const u of units) for (const a of u.avatars ?? []) all.add(a.avatarId);
      const d = decidePolicy({ container, kind: "archive", innerUnitypackagePaths: pkgRows.map((e) => e.relPath), mixedAvatarCount: all.size, parseState });
      units.unshift({
        relPath: "", format: container || "archive", kind: "container", name, size: Number(asset.size) || 0, fingerprint: fp,
        policy: d.policy, importable: false, parseState, parseError, avatars: [], evidence: { reason: d.reason },
      });
    }
    return [...units, ...limitedUnits];
  }

  const d = decidePolicy({ container, kind, innerUnitypackagePaths: [], mixedAvatarCount: 0, parseState });
  return [{
    relPath: "", format: container || kind || "unknown", kind: "container", name, size: Number(asset.size) || 0, fingerprint: fp,
    policy: d.policy, importable: false, parseState, parseError, avatars: [], evidence: { reason: d.reason },
  }];
}

/**
 * 分析一个条目的结构：upsert asset_units + 关系建议。
 * 解析失败只写单元上的 failed/unknown 证据（不伪造成功），不影响 assets 的索引状态。
 */
export async function analyzeItemStructure(repo: Repo, itemId: number, log: (m: string) => void = () => {}): Promise<AnalyzeItemResult> {
  if (!repo.getItem(itemId)) throw appErr("NOT_FOUND", "条目不存在: " + itemId, 404);
  const avatars: AvatarLite[] = (repo.listAvatars() as any[]).map((a) => ({ id: Number(a.id), name: String(a.name), aliases: (a.aliases ?? []).map(String) }));
  const itemAvatarIds = repo.itemAvatarIds(itemId);
  const assets = repo.listAssets(itemId);
  const ctx: AnalyzeCtx = { cache: new Map(), budget: { packages: 0, bytes: 0, started: Date.now() } };
  const errors: AnalyzeItemResult["errors"] = [];
  const relationUnits: StructureUnit[] = [];
  const allUnitIds: number[] = [];
  let unitCount = 0;

  for (const asset of assets) {
    try {
      const rows = await unitsOfAsset(repo, asset, avatars, itemAvatarIds, ctx);
      const ids = repo.replaceAssetUnits(asset.id, itemId, rows);
      unitCount += rows.length;
      for (const r of rows) {
        const id = ids.get(r.relPath);
        if (!id) continue;
        allUnitIds.push(id);
        relationUnits.push({ id: String(id), name: r.name, avatarIds: (r.avatars ?? []).map((a) => a.avatarId), kind: r.kind });
      }
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      errors.push({ assetId: asset.id, path: String(asset.path), message });
      const failRel = "__error__";
      const ids = repo.replaceAssetUnits(asset.id, itemId, [{
        relPath: failRel, format: String(asset.container ?? "unknown"), kind: "container", name: baseName(asset.path),
        size: Number(asset.size) || 0, fingerprint: fingerprintOf(asset), policy: "unknown_structure", importable: false,
        parseState: "failed", parseError: message, avatars: [], evidence: { reason: message },
      }]);
      const id = ids.get(failRel); if (id) allUnitIds.push(id);
      log("structure asset " + asset.id + " failed: " + message);
    }
  }

  const rels = relationCandidates(relationUnits, { limitPerUnit: 8 });
  const byId = new Map(relationUnits.map((u) => [u.id, Number(u.id)]));
  const mapped = rels.flatMap((r) => {
    const from = byId.get(r.from); const to = byId.get(r.to);
    if (!from || !to) return [];
    return [{ fromUnitId: from, toUnitId: to, type: r.type, evidence: r.evidence, confidence: r.confidence }];
  });
  repo.replaceUnitRelations(allUnitIds, mapped);
  return { itemId, assets: assets.length, units: unitCount, relations: mapped.length, errors };
}

// ---------------------------------------------------------------- 导入计划

export interface PrecheckUnit {
  unitId: number; assetId: number; path: string; name: string; policy: string;
  fingerprint: string | null; fingerprintNow: string | null; changed: boolean;
  fileExists: boolean; mixed: boolean; importable: boolean; status: string; error?: string | null;
}

export interface PlanView {
  plan: any; items: any[]; precheck: any;
  /** 最新一次执行批次 id（无执行过则为 null），前端据此轮询 /api/import-runs/:id。 */
  run_id: number | null;
  latestRun: { id: number; status: string; started_at: string | null; finished_at: string | null; summary: any; console_errors: any } | null;
  /** 最近一次执行失败的 {code,message,phase}（来自 latestRun.summary.error）；成功/未执行为 null。 */
  lastError: { code: string; message: string; phase?: string } | null;
  /** task-51：计划风险摘要 + 状态（clear/warning/blocked/unknown）；precheck 直接暴露给 UI。 */
  risks: PlanRiskSummary | null;
  risk_state: string | null;
}

function nowIso(): string { return new Date().toISOString(); }

function fingerprintNowOf(repo: Repo, planItem: any): string | null {
  const asset = repo.getAsset(Number(planItem.asset_id));
  if (!asset) return null;
  // 指纹含"单元大小"（压缩包内条目与整包 size 不同）；plan_item 不冗余 size，统一从 unit 读。
  const unit = repo.getUnitsByIds([Number(planItem.unit_id)])[0];
  return fingerprintOf(asset, Number(unit?.size ?? NaN) || undefined);
}

function suggestedUnitRows(repo: Repo, selected: any[]): any[] {
  const ids = selected.map((u) => Number(u.id));
  const rels = repo.listUnitRelations(ids);
  const out: any[] = [];
  const seen = new Set(ids);
  for (const r of rels) {
    if (r.type !== "suggested_companion" || !r.to_importable) continue;
    const id = Number(r.to_unit_id);
    if (seen.has(id)) continue;
    seen.add(id);
    const u = repo.getUnitsByIds([id])[0];
    if (u && Number(u.item_id) === Number(selected[0].item_id) && u.importable) out.push(u);
  }
  return out;
}

/**
 * 建计划：只保存"原始资产路径 + 指纹 + 单元引用"。
 * mixed 单元 path 仍是 asset.path（原始整包），不会出现任何筛选/拆分产物。
 */
export function createImportPlan(repo: Repo, input: { unitIds: number[]; projectPath: string; includeSuggested?: boolean }): PlanView {
  const unitIds = [...new Set((input.unitIds ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (unitIds.length === 0) throw appErr("INVALID_INPUT", "unitIds 不能为空", 400);
  const projectPath = String(input.projectPath ?? "").trim();
  if (!projectPath) throw appErr("INVALID_INPUT", "projectPath 不能为空", 400);
  const units = repo.getUnitsByIds(unitIds);
  if (units.length !== unitIds.length) throw appErr("INVALID_INPUT", "存在不存在的 unitId", 400);
  const bad = units.find((u) => !u.importable);
  if (bad) throw appErr("INVALID_INPUT", "单元不可导入（policy=" + bad.policy + "）: " + bad.name, 400);
  const itemIds = [...new Set(units.map((u) => Number(u.item_id)))];
  if (itemIds.length !== 1) throw appErr("INVALID_INPUT", "一次计划只能属于同一个条目", 400);
  const itemId = itemIds[0]!;

  const extras = input.includeSuggested ? suggestedUnitRows(repo, units) : [];
  const all = [...units, ...extras];
  const selectedIds = new Set(units.map((u) => Number(u.id)));
  const checkedAt = nowIso();
  const projectExists = existsSync(projectPath);
  const precheckUnits: PrecheckUnit[] = all.map((u) => {
    const asset = repo.getAsset(Number(u.asset_id));
    const fpNow = asset ? fingerprintOf(asset, Number(u.size) || undefined) : null;
    const changed = !asset || String(fpNow) !== String(u.fingerprint);
    const exists = !!asset && existsSync(String(asset.path));
    const mixed = u.policy === "mixed_unitypackage";
    const suggested = !selectedIds.has(Number(u.id));
    const status = changed ? "blocked" : suggested ? "suggested" : "pending";
    const error = changed ? "指纹已变化（单元=" + u.fingerprint + "，当前=" + fpNow + "）"
      : !exists ? "原始文件不存在：" + String(asset?.path ?? "")
      : null;
    return {
      unitId: Number(u.id), assetId: Number(u.asset_id), path: String(asset?.path ?? ""), name: String(u.name),
      policy: String(u.policy), fingerprint: u.fingerprint ?? null, fingerprintNow: fpNow, changed, fileExists: exists,
      mixed, importable: !!u.importable, status: error ? "blocked" : status, error,
    };
  });
  const warnings: string[] = [];
  if (precheckUnits.some((u) => u.mixed)) warnings.push("包含混合 .unitypackage：将导入整个原始包（不拆分、不生成筛选包）");
  if (extras.length) warnings.push("已按建议加入 " + extras.length + " 个伴生单元（status=suggested，确认后可执行）");
  if (!projectExists) warnings.push("Unity 工程路径当前不存在或不可访问：" + projectPath);
  const blocked = precheckUnits.some((u) => u.changed || !u.fileExists);
  const needsConfirm = blocked || extras.length > 0 || precheckUnits.some((u) => u.mixed) || precheckUnits.some((u) => u.status === "suggested");
  const status = blocked ? "blocked" : needsConfirm ? "needs_confirmation" : "ready";
  const precheck = { checkedAt, projectPath, projectExists, units: precheckUnits, warnings };
  const plan = repo.createImportPlan({ itemId, projectPath, policy: precheckUnits.some((u) => u.mixed) ? "mixed_unitypackage" : "single_unitypackage", status, precheck });
  for (const u of precheckUnits) {
    repo.addImportPlanItem({ planId: plan.id, unitId: u.unitId, assetId: u.assetId, path: u.path, policy: u.policy, fingerprint: u.fingerprint, status: u.status, error: u.error ?? null });
  }
  return getPlanView(repo, plan.id)!;
}

/**
 * task-49：跨 item 选择 → 按 item 分组各建一个计划；单 item 保持原 PlanView 形状。
 * 组内失败隔离：某组建计划失败只返回该组 error，不影响其它组。
 */
export function createImportPlanBatch(
  repo: Repo,
  input: { unitIds: number[]; projectPath: string; includeSuggested?: boolean },
): { single: true; view: PlanView } | { single: false; plans: any[] } {
  const ids = [...new Set((input.unitIds ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (ids.length === 0) throw appErr("INVALID_INPUT", "unitIds 不能为空", 400);
  const units = repo.getUnitsByIds(ids);
  if (units.length === 0) throw appErr("INVALID_INPUT", "unitIds 全部不存在", 400);
  const byItem = new Map<number, number[]>();
  for (const u of units) {
    const itemId = Number(u.item_id);
    if (!Number.isFinite(itemId) || itemId <= 0) continue;
    const arr = byItem.get(itemId) ?? [];
    arr.push(Number(u.id));
    byItem.set(itemId, arr);
  }
  const known = new Set(units.map((u) => Number(u.id)));
  const unknown = ids.filter((id) => !known.has(id));
  if (byItem.size <= 1 && unknown.length === 0) {
    return { single: true, view: createImportPlan(repo, { ...input, unitIds: ids }) };
  }
  const plans: any[] = [];
  for (const [itemId, groupIds] of byItem) {
    try {
      const view = createImportPlan(repo, { ...input, unitIds: groupIds });
      plans.push({ itemId, ...view });
    } catch (e) {
      plans.push({ itemId, error: { code: String((e as any)?.code ?? "ERROR"), message: String((e as any)?.message ?? e) } });
    }
  }
  if (unknown.length) plans.push({ itemId: null, error: { code: "INVALID_INPUT", message: "存在不存在的 unitId: " + unknown.join(",") } });
  return { single: false, plans };
}

export function getPlanView(repo: Repo, planId: number): PlanView | null {
  const plan = repo.getImportPlan(planId);
  if (!plan) return null;
  const latest = repo.latestImportRun(planId);
  const summary = latest ? safeJson(latest.summary_json) : null;
  const err = summary && typeof summary === "object" ? (summary as any).error : null;
  return {
    plan, items: repo.listImportPlanItems(planId), precheck: safeJson(plan.precheck_json),
    run_id: latest ? Number(latest.id) : null,
    latestRun: latest ? {
      id: Number(latest.id), status: String(latest.status),
      started_at: latest.started_at ?? null, finished_at: latest.finished_at ?? null,
      summary, console_errors: safeJson(latest.console_errors),
    } : null,
    lastError: err && typeof err === "object" ? { code: String(err.code ?? "ERROR"), message: String(err.message ?? ""), ...(err.phase ? { phase: String(err.phase) } : {}) } : null,
    risks: safeJson(plan.risk_json), risk_state: plan.risk_state ?? null,
  };
}

function safeJson(text: string | null | undefined): any {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** 人工确认：blocked 不可确认；suggested 条目转 pending。 */
/**
 * task-51 风险确认：confirm 必须带 riskAck。warning/unknown 未 ack → 409 RISK_REQUIRES_ACK；
 * blocked 未 ack → RISK_BLOCKED（blocked 即使 ack 也不放行）。ack 时间/摘要写进 risk_json。
 */
export function confirmImportPlan(repo: Repo, planId: number, opts: { riskAck?: boolean } = {}): PlanView {
  const plan = repo.getImportPlan(planId);
  if (!plan) throw appErr("NOT_FOUND", "计划不存在", 404);
  if (plan.status === "blocked" || plan.risk_state === "blocked") {
    throw appErr("RISK_BLOCKED", "计划被风险规则阻断，不能确认执行", 409);
  }
  const riskState = String(plan.risk_state ?? "");
  if ((riskState === "warning" || riskState === "unknown") && opts.riskAck !== true) {
    throw appErr("RISK_REQUIRES_ACK", "计划包含风险内容，需要显式 riskAck 确认后才能执行", 409);
  }
  let riskJson = plan.risk_json ?? null;
  if (riskState === "warning" || riskState === "unknown") {
    const prev = safeJson(plan.risk_json) ?? {};
    riskJson = JSON.stringify({ ...prev, risk_ack_at: nowIso(), risk_ack_digest: String(prev.digest ?? "") });
  }
  for (const it of repo.listImportPlanItems(planId)) {
    if (it.status === "suggested") repo.updateImportPlanItem(it.id, { status: "pending" });
  }
  repo.updateImportPlan(planId, { user_confirmed: 1, status: "ready", ...(riskJson ? { risk_json: riskJson } : {}) });
  return getPlanView(repo, planId)!;
}

// ---------------------------------------------------------------- 执行

export interface ExecuteDeps {
  repo: Repo;
  unity: UnityMcp;
  stagingDir: string;
  log?: (m: string) => void;
  /** 导入命令返回后等 Unity 落盘的毫秒数（默认 1500） */
  waitMs?: number;
  /** 触发执行的 job id（写 staging 台账） */
  jobId?: number;
}

/** task-51：扫描工程 Assets 下全部 .meta 的 guid（读不了工程 → ok=false，调用方落 unknown）。 */
export function scanProjectGuids(projectPath: string, fileLimit = 200_000): { ok: boolean; guids: Set<string>; files: number } {
  const root = join(projectPath, "Assets");
  if (!existsSync(root)) return { ok: false, guids: new Set(), files: 0 };
  const guids = new Set<string>();
  const stack = [root];
  let files = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return { ok: false, guids, files }; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.name.toLowerCase().endsWith(".meta")) continue;
      if (++files > fileLimit) return { ok: false, guids, files };
      try {
        const m = /\bguid:\s*([0-9a-f]{32})\b/i.exec(readFileSync(full, "utf8"));
        if (m) guids.add(m[1]!.toLowerCase());
      } catch { return { ok: false, guids, files }; }
    }
  }
  return { ok: true, guids, files };
}

export interface VerificationCoverage {
  ok: boolean; scope: "all" | "sampled"; expected: number; checked: number;
  found: number; missing: number; missingGuids: string[]; detail?: string;
}

/** task-51：验证覆盖。≤500 全量比对；>500 抽样 500 并标 sampled；missing=0 才算 verified。 */
export function verifyCoverage(projectPath: string, expectedGuids: string[]): VerificationCoverage {
  const all = [...new Set(expectedGuids.map((g) => String(g).trim().toLowerCase()).filter(Boolean))];
  if (all.length === 0) return { ok: false, scope: "all", expected: 0, checked: 0, found: 0, missing: 0, missingGuids: [], detail: "没有可验证的期望 GUID" };
  const scope: "all" | "sampled" = all.length <= 500 ? "all" : "sampled";
  const list = scope === "all" ? all : all.slice(0, 500);
  const scan = scanProjectGuids(projectPath);
  if (!scan.ok) return { ok: false, scope, expected: all.length, checked: 0, found: 0, missing: list.length, missingGuids: list.slice(0, 50), detail: "无法读取工程 Assets" };
  const missing = list.filter((g) => !scan.guids.has(g));
  return { ok: true, scope, expected: all.length, checked: list.length, found: list.length - missing.length, missing: missing.length, missingGuids: missing.slice(0, 50) };
}

/** 执行前置校验（路由与 runner 共用）：blocked/confirm/指纹；不产生任何副作用。 */
/** task-51：计划级风险摘要（包内路径 + 外层 archive_entries；扫描器版本/摘要用于执行前一致性校验）。 */
export interface PlanRiskSummary {
  scannerVersion: number;
  digest: string;
  state: RiskState;
  hits: RiskHit[];
  scanned: number;
  truncated: boolean;
  itemDigests: Record<string, string>;
  generatedAt: string;
}
function digestOf(text: string): string { return createHash("sha256").update(text).digest("hex").slice(0, 16); }

/** 计算计划的当前风险（只读；不写库）。包内路径解析失败按 unknown，绝不猜 clear。 */
export async function computePlanRisk(repo: Repo, planId: number): Promise<PlanRiskSummary> {
  const items = repo.listImportPlanItems(planId);
  const ctx: AnalyzeCtx = { cache: new Map(), budget: { packages: 0, bytes: 0, started: Date.now() } };
  const all: string[] = [];
  const itemDigests: Record<string, string> = {};
  let incomplete = false;
  for (const it of items) {
    const asset = repo.getAsset(Number(it.asset_id));
    if (!asset) { incomplete = true; continue; }
    const direct = String(asset.kind) === "unitypackage" || String(asset.container) === "unitypackage";
    all.push(String(asset.path));
    let paths: string[] = [];
    if (direct) {
      paths = (repo.getUnityPackageAssets(asset.id) as any[]).map((r) => String(r.assetPath));
    }
    if (paths.length === 0) {
      const parsed = await readPackageAssetPaths(asset, String(it.rel_path ?? ""), ctx);
      if (parsed.ok) paths = parsed.paths; else incomplete = true;
    }
    // 外层容器条目同样是 Unity 包可能携带的内容
    if (!direct) paths.push(...(repo.getArchiveEntries(asset.id) as any[]).map((e) => String(e.path)));
    itemDigests[String(it.id)] = digestOf([...paths].sort().join("\n"));
    all.push(...paths);
  }
  // task-51/56：magic 检测只读真实磁盘文件前 ≤8B（包内虚拟路径读不到就返回 null，不猜）
  const magicReader = (p: string): string | null => {
    try {
      if (!existsSync(p) || !statSync(p).isFile()) return null;
      const fd = openSync(p, "r");
      try { const b = Buffer.alloc(8); const n = readSync(fd, b, 0, 8, 0); return b.subarray(0, n).toString("latin1"); }
      finally { closeSync(fd); }
    } catch { return null; }
  };
  const scan: RiskScanResult = scanPaths([...new Set(all)], { incomplete, magic: magicReader });
  return {
    scannerVersion: RISK_SCANNER_VERSION,
    digest: digestOf(items.map((it: any) => it.id + ":" + (itemDigests[String(it.id)] ?? "")).sort().join("|") + "|v" + RISK_SCANNER_VERSION),
    state: scan.state, hits: scan.hits.slice(0, 200), scanned: scan.scanned, truncated: scan.truncated,
    itemDigests, generatedAt: nowIso(),
  };
}

/** 建计划后写入风险；warning/unknown 要求人工确认，blocked 直接阻断（已确认计划不改状态）。 */
export async function applyPlanRisk(repo: Repo, planId: number): Promise<PlanView | null> {
  const risk = await computePlanRisk(repo, planId);
  const plan = repo.getImportPlan(planId);
  if (!plan) return null;
  let status = String(plan.status);
  if (!plan.user_confirmed) {
    if (risk.state === "blocked") status = "blocked";
    else if (risk.state === "warning" || risk.state === "unknown") status = "needs_confirmation";
  }
  repo.updateImportPlan(planId, { risk_json: JSON.stringify(risk), risk_state: risk.state, status });
  return getPlanView(repo, planId);
}

/**
 * 执行前 precheck（含风险重扫）：风险扫描器版本/摘要与计划快照不一致 → 写回新风险并 blocked。
 * 返回 risks 供 UI/日志；风险一致才允许继续执行。
 */
export async function precheckImportPlanWithRisk(repo: Repo, planId: number): Promise<{ plan: any; items: any[]; changed: any[]; risks: PlanRiskSummary }> {
  const checked = precheckImportPlan(repo, planId);
  const current = await computePlanRisk(repo, planId);
  const stored = safeJson(checked.plan.risk_json) as PlanRiskSummary | null;
  if (!stored) {
    // 计划由旧版本/服务直建时没有风险快照：先补扫一次；warning/unknown 要求确认，blocked 阻断。
    let status = String(checked.plan.status);
    if (!checked.plan.user_confirmed) {
      if (current.state === "blocked") status = "blocked";
      else if (current.state === "warning" || current.state === "unknown") status = "needs_confirmation";
    }
    repo.updateImportPlan(planId, { risk_json: JSON.stringify(current), risk_state: current.state, status });
    if (status === "blocked") throw appErr("RISK_BLOCKED", "包内风险规则阻断导入", 409);
    if (status === "needs_confirmation" && !checked.plan.user_confirmed) throw appErr("CONFIRM_REQUIRED", "风险扫描需要人工确认后才能执行", 409);
    return { ...checked, plan: { ...checked.plan, risk_json: JSON.stringify(current), risk_state: current.state, status }, risks: current };
  }
  const mismatch = Number(stored.scannerVersion) !== current.scannerVersion || String(stored.digest) !== current.digest || String(checked.plan.risk_state ?? "") !== current.state;
  if (mismatch) {
    repo.updateImportPlan(planId, {
      risk_json: JSON.stringify(current), risk_state: current.state, status: "blocked",
      precheck_json: JSON.stringify({ checkedAt: nowIso(), riskChanged: true, previous: { scannerVersion: stored.scannerVersion, digest: stored.digest, state: stored.state }, current: { scannerVersion: current.scannerVersion, digest: current.digest, state: current.state } }),
    });
    throw appErr("RISK_CHANGED", "风险扫描与计划快照不一致（版本/摘要变化），已阻断，请重新确认", 409);
  }
  return { ...checked, risks: stored };
}

export function precheckImportPlan(repo: Repo, planId: number): { plan: any; items: any[]; changed: any[] } {
  const plan = repo.getImportPlan(planId);
  if (!plan) throw appErr("NOT_FOUND", "计划不存在", 404);
  if (plan.status === "blocked") throw appErr("PLAN_BLOCKED", "计划已被阻断（precheck 失败）", 409);
  if (plan.risk_state === "blocked") throw appErr("RISK_BLOCKED", "计划被风险规则阻断，不能执行", 409);
  if (!plan.user_confirmed && (plan.risk_state === "warning" || plan.risk_state === "unknown")) {
    throw appErr("RISK_REQUIRES_ACK", "计划包含风险内容，需要 riskAck 确认后才能执行", 409);
  }
  if (!plan.user_confirmed && plan.status === "needs_confirmation") throw appErr("CONFIRM_REQUIRED", "计划需要人工确认后才能执行", 409);
  // 已执行/失败/执行中的计划不允许再次执行（外部副作用不可重放；需要重跑请重新建计划）
  if (!["ready", "needs_confirmation"].includes(String(plan.status))) {
    throw appErr("PLAN_NOT_EXECUTABLE", "计划当前状态不可执行: " + plan.status + "（不会自动/重复导入）", 409);
  }
  const items = repo.listImportPlanItems(planId).filter((it: any) => it.status !== "failed");
  if (items.length === 0) throw appErr("INVALID_INPUT", "计划没有可执行条目", 400);
  const changed = items.filter((it: any) => fingerprintNowOf(repo, it) !== it.fingerprint);
  if (changed.length) {
    repo.updateImportPlan(planId, { status: "blocked", precheck_json: JSON.stringify({ checkedAt: nowIso(), fingerprintChanged: changed.map((c: any) => c.id) }) });
    throw appErr("FINGERPRINT_CHANGED", "原始文件指纹已变化，计划已阻断（" + changed.length + " 项）", 409);
  }
  return { plan, items, changed: [] };
}

/** 作业失败/中断：把未完成的 run 标 interrupted、计划标 failed，防止自动重试外部导入。 */
export function markImportInterrupted(repo: Repo, planId: number, reason: string): void {
  const run = repo.latestImportRun(planId);
  if (run && (run.status === "running" || run.status === "pending")) {
    repo.updateImportRun(run.id, { status: "interrupted", finished_at: nowIso(), summary_json: JSON.stringify({ reason: String(reason).slice(0, 300) }) });
  }
  repo.updateImportPlan(planId, { status: "failed" });
}

/**
 * task-46：前置失败（Unity 离线/工程不匹配/指纹变化等）也要留下可审计的 failed run + 逐项 run_items，
 * 否则 plan=failed 但 run_id=null、用户看不到原因。
 */
function recordPreflightFailure(repo: Repo, planId: number, err: unknown): void {
  try {
    const plan = repo.getImportPlan(planId);
    if (!plan) return;
    const code = String((err as any)?.code ?? "ERROR");
    const message = String((err as Error)?.message ?? err);
    const items = repo.listImportPlanItems(planId);
    const run = repo.createImportRun({ planId, projectPath: plan.project_path });
    for (const it of items) {
      const ri = repo.addImportRunItem({ runId: run.id, planItemId: it.id, unitId: it.unit_id });
      repo.updateImportRunItem(ri.id, {
        status: "failed", started_at: nowIso(), finished_at: nowIso(),
        error: code + ": " + message, detail_json: JSON.stringify({ phase: "preflight" }),
      });
    }
    repo.updateImportRun(run.id, {
      status: "failed", finished_at: nowIso(),
      console_errors: JSON.stringify([code + ": " + message]),
      summary_json: JSON.stringify({ phase: "preflight", error: { code, message }, total: items.length, failed: items.length }),
    });
    // precheck 已把计划置 blocked（风险/指纹）时保留 blocked 语义，只有真正执行失败才落 failed
    const cur = repo.getImportPlan(planId);
    if (cur && !["blocked", "needs_confirmation"].includes(String(cur.status))) repo.updateImportPlan(planId, { status: "failed" });
  } catch { /* 审计记录失败不掩盖原始错误 */ }
}

/** task-51：staging 台账清理。verified/partial_success 结束即清理；unknown/failed 保留（供 7 天 sweep）。 */
export function cleanupStagingForRun(repo: Repo, runId: number, status: string): { removed: number; failed: number; kept: number } {
  const rows = repo.listStagingFiles({ runId, limit: 2000 });
  if (!["verified", "partial_success"].includes(String(status))) return { removed: 0, failed: 0, kept: rows.length };
  let removed = 0; let failed = 0;
  for (const row of rows) {
    repo.updateStagingFile(row.id, { state: "cleanup_pending" });
    try { unlinkSync(String(row.path)); repo.deleteStagingFile(row.id); removed++; }
    catch (e) {
      if ((e as any)?.code === "ENOENT") { repo.deleteStagingFile(row.id); removed++; continue; }
      failed++;
      repo.updateStagingFile(row.id, { state: "cleanup_failed", cleanup_error: String((e as Error)?.message ?? e).slice(0, 300), cleanup_attempts: Number(row.cleanup_attempts ?? 0) + 1 });
    }
  }
  return { removed, failed, kept: rows.length - removed - failed };
}

function underDir(parent: string, child: string): boolean {
  const p = normalizePath(parent).replace(/\/+$/, "");
  const c = normalizePath(child);
  return c === p || c.startsWith(p + "/");
}

export interface StagingSweepResult { candidates: number; removed: number; failed: number; skipped: number; errors: string[] }

/**
 * task-51：清理过期 staging（默认 >7 天且非活跃）。安全边界：
 * 路径必须在 stagingDir 内、拒绝符号链接、只删已登记行；dryRun 只报告不写库/不删文件。
 */
export function sweepStaging(repo: Repo, stagingDir: string, opts: { olderThanDays?: number; dryRun?: boolean; now?: number } = {}): StagingSweepResult {
  const days = Math.max(0, Number(opts.olderThanDays ?? 7));
  const dryRun = opts.dryRun === true;
  const nowMs = Number(opts.now ?? Date.now());
  const cutoff = new Date(nowMs - days * 86_400_000).toISOString();
  const rows = repo.listStaleStagingFiles(cutoff, 1000);
  const res: StagingSweepResult = { candidates: 0, removed: 0, failed: 0, skipped: 0, errors: [] };
  for (const row of rows) {
    const path = String(row.path);
    if (!underDir(stagingDir, path)) { res.skipped++; res.errors.push("越界路径，拒绝清理: " + path); if (!dryRun) repo.updateStagingFile(row.id, { cleanup_error: "路径不在 unity-staging 内" }); continue; }
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) { res.skipped++; res.errors.push("符号链接，拒绝清理: " + path); if (!dryRun) repo.updateStagingFile(row.id, { cleanup_error: "符号链接，拒绝清理" }); continue; }
    } catch (e) {
      if ((e as any)?.code === "ENOENT") { res.candidates++; if (!dryRun) { repo.deleteStagingFile(row.id); res.removed++; } continue; }
      res.failed++; res.errors.push("无法 stat: " + path); continue;
    }
    // 活跃执行中的 staging 不清理
    const run = row.run_id ? repo.getImportRun(Number(row.run_id)) : null;
    if (run && (run.status === "running" || run.status === "prechecking")) { res.skipped++; continue; }
    res.candidates++;
    if (dryRun) continue;
    try { unlinkSync(path); repo.deleteStagingFile(row.id); res.removed++; }
    catch (e) {
      res.failed++;
      repo.updateStagingFile(row.id, { state: "cleanup_failed", cleanup_error: String((e as Error)?.message ?? e).slice(0, 300), cleanup_attempts: Number(row.cleanup_attempts ?? 0) + 1 });
    }
  }
  return res;
}

/**
 * task-57：启动收养历史 staging 文件（生产可能已有未登记文件）。
 * 递归扫描 stagingDir：只认普通文件（拒符号链接/目录），跳过已登记 path_norm；登记 state='stale'，
 * last_used_at 用文件 mtime（过期判断基于历史时间）；返回收养数量。
 */
export function adoptLegacyStaging(repo: Repo, stagingDir: string, opts: { maxFiles?: number; maxDepth?: number } = {}): { adopted: number; skipped: number; errors: string[] } {
  const maxFiles = Math.max(1, Number(opts.maxFiles ?? 5000));
  const maxDepth = Math.max(1, Number(opts.maxDepth ?? 8));
  const res = { adopted: 0, skipped: 0, errors: [] as string[] };
  if (!existsSync(stagingDir)) return res;
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || res.adopted >= maxFiles) return;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { res.errors.push("无法读取目录 " + dir); res.skipped++; return; }
    for (const e of entries) {
      if (res.adopted >= maxFiles) return;
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) { res.skipped++; res.errors.push("符号链接，拒绝收养: " + full); continue; }
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!e.isFile()) { res.skipped++; continue; }
      let st: import("node:fs").Stats;
      try { st = lstatSync(full); } catch { res.skipped++; continue; }
      if (!st.isFile()) { res.skipped++; continue; }
      if (!underDir(stagingDir, full)) { res.skipped++; res.errors.push("越界路径，拒绝收养: " + full); continue; }
      const existing = repo.getStagingFileByPath(full);
      if (existing) { res.skipped++; continue; }
      try {
        const row = repo.registerStagingFile({ path: full, size: Number(st.size) || 0, state: "stale" });
        repo.updateStagingFile(row.id, { last_used_at: new Date(st.mtimeMs).toISOString() });
        res.adopted++;
      } catch (e) { res.skipped++; res.errors.push("登记失败 " + full + ": " + String((e as Error)?.message ?? e)); }
    }
  };
  walk(stagingDir, 0);
  return res;
}

export function sweepStagingOnStartup(repo: Repo, stagingDir: string): StagingSweepResult {
  return sweepStaging(repo, stagingDir, { olderThanDays: 7, dryRun: false });
}

/** 执行计划：逐单元独立状态；命令返回 ≠ 验证成功。 */
export async function executeImportPlan(deps: ExecuteDeps, planId: number): Promise<{ run: any; items: any[] }> {
  const { repo, unity } = deps;
  const log = deps.log ?? (() => {});
  const current = repo.getImportPlan(planId);
  if (!current) throw appErr("NOT_FOUND", "计划不存在", 404);
  // 崩溃/租约丢失后的自动重领：已有未完成 run → 标 interrupted 并拒绝重跑（外部副作用不可重放）。
  if (current.status === "running") {
    const existing = repo.latestImportRun(planId);
    if (existing && existing.status === "running") {
      repo.updateImportRun(existing.id, { status: "interrupted", finished_at: nowIso(), summary_json: JSON.stringify({ reason: "previous import job lost/interrupted" }) });
      repo.updateImportPlan(planId, { status: "failed" });
      throw appErr("PLAN_INTERRUPTED", "该计划已有未完成的执行（已标记 interrupted），不会自动重试外部导入", 409);
    }
  }
  let checked: { plan: any; items: any[] };
  try {
    checked = await precheckImportPlanWithRisk(repo, planId);
  } catch (e) {
    recordPreflightFailure(repo, planId, e);
    throw e;
  }
  const { plan, items } = checked;

  let editor: any;
  try {
    editor = await unityEditorInfo(unity);
    if (!editor?.projectPath) throw appErr("UNITY_UNAVAILABLE", "Unity 编辑器不可用或未返回工程路径", 409);
    if (normalizePath(String(editor.projectPath)) !== normalizePath(String(plan.project_path))) {
      throw appErr("PROJECT_MISMATCH", "Unity 当前工程与计划不一致：编辑器=" + editor.projectPath + "，计划=" + plan.project_path, 409);
    }
  } catch (e) {
    recordPreflightFailure(repo, planId, e);
    throw e;
  }

  const run = repo.createImportRun({ planId, projectPath: plan.project_path });
  const runItems = items.map((it: any) => ({ it, ri: repo.addImportRunItem({ runId: run.id, planItemId: it.id, unitId: it.unit_id }) }));
  repo.updateImportPlan(planId, { status: "running" });
  const consoleAll: string[] = [];
  let verified = 0; let partial = 0; let failed = 0; let unknown = 0; let cancelled = 0;
  let checkedTotal = 0; let expectedTotal = 0; const scopes: string[] = [];
  const verifyCtx: AnalyzeCtx = { cache: new Map(), budget: { packages: 0, bytes: 0, started: Date.now() } };

  for (const { it, ri } of runItems) {
    if (String(repo.getImportRun(run.id)?.status) === "cancelled") { cancelled++; continue; }
    let phase = "staging";
    let commandSent = false;
    try {
      const asset = repo.getAsset(Number(it.asset_id));
      if (!asset) throw appErr("NOT_FOUND", "资产不存在: " + it.asset_id, 404);
      // task-45：depth3 的 outer::inner::pkg 也递归解到 staging（原包内容，不生成筛选包）
      const stagedPath = await stageUnitPackage(asset, String(it.rel_path ?? ""), deps.stagingDir, String(it.unit_id));
      let stagedSize = 0;
      try { stagedSize = statSync(stagedPath).size; } catch { /* 记录 0 也保留台账 */ }
      repo.registerStagingFile({ path: stagedPath, size: stagedSize, planId, runId: run.id, jobId: deps.jobId ?? null, state: "in_use" });
      if (String(repo.getImportRun(run.id)?.status) === "cancelled") {
        cancelled++;
        transitionRunItem(repo, ri.id, "cancelled", { finished_at: nowIso(), error: "CANCELLED: user cancelled", detail_json: JSON.stringify({ phase: "staging", possible_side_effect: false }) });
        continue;
      }
      phase = "importing";
      transitionRunItem(repo, ri.id, "importing", { started_at: nowIso() });
      await clearUnityConsole(unity);
      const r = await importPackagesIntoUnity(unity, [stagedPath]);
      if (r.failed.length > 0) {
        failed++;
        transitionRunItem(repo, ri.id, "failed", { finished_at: nowIso(), error: r.failed.join("; "), detail_json: JSON.stringify({ stagedPath, raw: r.raw, phase: "importing", possible_side_effect: false }) });
        continue;
      }
      commandSent = true; phase = "verifying";
      transitionRunItem(repo, ri.id, "import_command_completed", { detail_json: JSON.stringify({ stagedPath, queued: r.queued, raw: r.raw }) });
      transitionRunItem(repo, ri.id, "verifying");
      if (String(repo.getImportRun(run.id)?.status) === "cancelled") {
        cancelled++;
        transitionRunItem(repo, ri.id, "cancelled", { finished_at: nowIso(), error: "CANCELLED: user cancelled", detail_json: JSON.stringify({ phase: "verifying", possible_side_effect: true }) });
        continue;
      }
      await sleep(deps.waitMs ?? 1500);
      // 命令已发：先探活，读控制台内部会吞网络错误，不能作为断线判据
      if (!(await unitySessionHealthy(unity))) throw appErr("UNITY_DISCONNECTED", "Unity 会话在导入命令发出后断开（可能已产生副作用）", 409);
      const errs = await readUnityConsole(unity, ["error"], 20);
      consoleAll.push(...errs);
      // task-51：expected GUID ≤500 全量、>500 抽样；工程 .meta 全量扫描后比对
      let expectedGuids = repo.listUnitypackageGuids(Number(it.asset_id));
      if (expectedGuids.length === 0) {
        const parsed = await readPackageAssetPaths(asset, String(it.rel_path ?? ""), verifyCtx);
        if (parsed.ok) expectedGuids = parsed.guids;
      }
      const cov = verifyCoverage(String(plan.project_path), expectedGuids);
      if (!cov.ok) {
        unknown++;
        const cur = String(repo.getImportRunItem(ri.id)?.status ?? "verifying");
        if (canTransitionRunItem(cur, "unknown")) {
          repo.updateImportRunItem(ri.id, {
            status: "unknown", finished_at: nowIso(), error: "UNKNOWN: " + (cov.detail ?? "无法验证"),
            detail_json: JSON.stringify({ phase: "verifying", possible_side_effect: true, verification: cov, policy: it.policy, relPath: it.rel_path }),
          });
        }
        continue;
      }
      checkedTotal += cov.checked; expectedTotal += cov.expected; scopes.push(cov.scope);
      const detail = { stagedPath, consoleErrors: errs, verificationScope: cov.scope, checked: cov.checked, expected: cov.expected, found: cov.found, missing: cov.missing, missingGuids: cov.missingGuids, policy: it.policy, relPath: it.rel_path };
      if (cov.missing === 0 && errs.length === 0) {
        verified++;
        transitionRunItem(repo, ri.id, "verified", { finished_at: nowIso(), detail_json: JSON.stringify(detail) });
      } else {
        partial++;
        transitionRunItem(repo, ri.id, "partial_success", { finished_at: nowIso(), detail_json: JSON.stringify(detail) });
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      const code = String((e as any)?.code ?? "");
      const disconnected = commandSent || /UPSTREAM|HTTP|session|connect|socket|ECONN|timeout|abort|disconnect/i.test(msg + " " + code);
      if (disconnected) {
        // 命令可能已送达：unknown（可能产生副作用），绝不自动重试
        unknown++;
        const curStatus = String(repo.getImportRunItem(ri.id)?.status ?? "importing");
        try {
          if (canTransitionRunItem(curStatus, "unknown")) {
            repo.updateImportRunItem(ri.id, { status: "unknown", finished_at: nowIso(), error: "UNKNOWN: " + msg, detail_json: JSON.stringify({ phase, possible_side_effect: commandSent, relPath: it.rel_path, policy: it.policy }) });
          }
        } catch { /* 状态已终态 */ }
        log("import plan " + planId + " unit " + it.unit_id + " unknown: " + msg);
      } else {
        failed++;
        const curStatus = String(repo.getImportRunItem(ri.id)?.status ?? "importing");
        if (canTransitionRunItem(curStatus, "failed")) {
          repo.updateImportRunItem(ri.id, { status: "failed", finished_at: nowIso(), error: msg, detail_json: JSON.stringify({ relPath: it.rel_path, policy: it.policy, phase }) });
        }
        log("import plan " + planId + " unit " + it.unit_id + " failed: " + msg);
      }
    }
  }

  const runNow = repo.getImportRun(run.id);
  const wasCancelled = String(runNow?.status) === "cancelled";
  const status = wasCancelled ? "cancelled"
    : unknown > 0 ? "unknown"
    : failed === runItems.length ? "failed"
    : verified === runItems.length ? "verified"
    : "partial_success";
  const verificationScope = scopes.length === 0 ? null : scopes.some((s) => s === "sampled") ? "sampled" : "all";
  const updatedRun = repo.updateImportRun(run.id, {
    status, finished_at: nowIso(), console_errors: JSON.stringify(consoleAll.slice(0, 100)),
    verification_scope: verificationScope, checked_count: checkedTotal, expected_count: expectedTotal,
    summary_json: JSON.stringify({ total: runItems.length, verified, partial_success: partial, failed, unknown, cancelled, verificationScope, checked: checkedTotal, expected: expectedTotal, phase: wasCancelled ? "cancelled" : "done" }),
  });
  // verified/partial_success 结束后清 staging；unknown/failed 保留（7 天后 sweep）
  cleanupStagingForRun(repo, run.id, status);
  const planStatus = status === "verified" || status === "partial_success" ? "executed" : status;
  repo.updateImportPlan(planId, { status: planStatus });
  return { run: updatedRun, items: repo.listImportRunItems(run.id) };
}

/**
 * task-51：取消执行（不自动重试）。已进入导入/验证阶段的 item 标 possible_side_effect=true。
 * 幂等：终态 run 原样返回。
 */
export function cancelImportRun(repo: Repo, runId: number): { run: any; items: any[] } {
  const run = repo.getImportRun(runId);
  if (!run) throw appErr("NOT_FOUND", "执行记录不存在", 404);
  const terminal = ["verified", "partial_success", "failed", "unknown", "cancelled", "interrupted"];
  if (!terminal.includes(String(run.status))) {
    let possible = false;
    for (const it of repo.listImportRunItems(runId)) {
      if (["verified", "partial_success", "failed", "unknown", "cancelled"].includes(String(it.status))) continue;
      const phase = String(it.status);
      const sideEffect = ["importing", "import_command_completed", "verifying"].includes(phase);
      if (sideEffect) possible = true;
      if (canTransitionRunItem(phase, "cancelled")) {
        repo.updateImportRunItem(it.id, {
          status: "cancelled", finished_at: nowIso(), error: "CANCELLED: user cancelled",
          detail_json: JSON.stringify({ phase, possible_side_effect: sideEffect }),
        });
      }
    }
    repo.updateImportRun(runId, {
      status: "cancelled", finished_at: nowIso(),
      summary_json: JSON.stringify({ phase: "cancelled", possible_side_effect: possible }),
    });
  }
  return getRunView(repo, runId)!;
}

export function getRunView(repo: Repo, runId: number): { run: any; items: any[] } | null {
  const run = repo.getImportRun(runId);
  if (!run) return null;
  return { run, items: repo.listImportRunItems(runId) };
}
