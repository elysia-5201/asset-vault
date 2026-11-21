/**
 * 接受列表导入与 expected 重验（spec §6.3 / §9.1）。
 *
 * 契约：
 *  - `files` 形状执行阶段**不递归**：每项是一个文件路径，且必须带 `expected`（size+mtime，sha256 可选）。
 *  - `expected.sha256` 存在 → 当次强制重算并比对（不信任库内时间戳/旧哈希）；不存在 → 只比 size+mtime，
 *    结果记 `verified:"metadata"`，不冒充 exact。
 *  - 重复路径按 `normalizePath` 去重，保留第一次出现，其余进 `duplicates`，不重复建 job。
 *  - `paths` 旧形状原样保留（目录递归、无 expected），job payload 记 `legacy:true` 便于审计。
 *  - 归属（新 `files` 形状）：`path_norm` 已属于另一个 item（含“新建 item 意图”遇到任何既有 owner）
 *    → 该文件失败 `CONFLICT` + `details.code="PATH_OWNED_BY_OTHER_ITEM"`，不登记、不迁老 owner；
 *    同一 item 同一路径幂等。legacy 形状不套此门（保持旧 upsert 语义）。
 *  - 批次保护（§9.1）：只有“跨 owner 且该 asset 有 version links”才跳过该文件；无 link 不跳过。
 *
 * 本模块只做校验/建 job/查归属，不写 items/assets，不调用任何合并/查重写路径。
 */
import { constants, statSync } from "node:fs";
import { link, lstat, mkdtemp, realpath, rm, stat, copyFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { AppError } from "../../../../packages/core/src/contracts";
import { sha256FileChunked } from "../../../../packages/core/src/hash";
import { normalizePath } from "../../../../packages/core/src/pathnorm";
import { parseBoothUrl } from "../../../../packages/core/src/source/booth";
import type { Repo } from "../db/repo";

export interface AcceptedFileExpected { size: number; mtime: string; sha256?: string }
export interface AcceptedFileGroup { rootPath: string; rootId: number | null }
export interface AcceptedFile { path: string; expected: AcceptedFileExpected; group?: AcceptedFileGroup }

export interface ImportPathJobsResult { jobIds: number[]; duplicates: string[]; legacy: boolean }

export type AcceptedFileVerifyResult =
  | { ok: true; verified: "sha256" | "metadata" }
  | { ok: false; reason: "PRECHECK_STALE" | "PATH_OWNED_BY_OTHER_ITEM"; details?: { itemId: number; assetId: number } };

export type OwnerConflictResult = { skip: false } | { skip: true; itemId: number; assetId: number };

const invalid = (code: string, message: string): AppError => new AppError("INVALID_INPUT", message, 400, { code });

function expectedOf(f: AcceptedFile): AcceptedFileExpected | null {
  const e = f?.expected;
  if (!e || typeof e.size !== "number" || !Number.isFinite(e.size) || typeof e.mtime !== "string" || e.mtime === "") return null;
  return e;
}

/**
 * 建导入作业：`files` 新形状（每文件一个 `import_file` job，payload `{path, expected, group}`）；
 * 否则按 `paths` 旧形状（payload `{path, legacy:true}`，行为与现状一致）。
 */
export function createImportPathJobs(deps: { repo: Repo }, body: { paths?: string[]; files?: AcceptedFile[]; destination?: unknown; boothUrl?: unknown }): ImportPathJobsResult {
  const { repo } = deps;
  if (Array.isArray(body?.files)) {
    const jobIds: number[] = [];
    const duplicates: string[] = [];
    const seen = new Set<string>();
    const destination = body.destination === undefined ? undefined : importDestination(body.destination);
    const boothUrl = typeof body.boothUrl === "string" ? body.boothUrl.trim() : "";
    const booth = boothUrl ? parseBoothUrl(boothUrl) : null;
    if ((boothUrl && !booth) || (body.boothUrl !== undefined && typeof body.boothUrl !== "string")) {
      throw invalid("INVALID_BOOTH_LINK", "请输入有效的 BOOTH 商品链接或商品编号");
    }
    const accepted: AcceptedFile[] = [];
    for (const f of body.files) {
      const path = String(f?.path ?? "");
      if (!path) throw new AppError("INVALID_INPUT", "files 每项必须有 path", 400);
      // 目录展开只发生在预检；执行阶段拿到目录就是契约破坏。stat 失败（文件已消失）留给执行期
      // 的 expected 重验按 PRECHECK_STALE 失败，不在这里伪造 400。
      let isDir = false;
      try { isDir = statSync(path).isDirectory(); } catch { isDir = false; }
      if (isDir) throw invalid("DIRECTORY_NOT_ALLOWED_WITH_FILES", `files 形状不接受目录（目录展开只在预检）: ${path}`);
      const expected = expectedOf(f);
      if (!expected) throw invalid("EXPECTED_REQUIRED", `files 每项必须带 expected.size/expected.mtime: ${path}`);
      const norm = normalizePath(path);
      if (seen.has(norm)) { duplicates.push(path); continue; }
      seen.add(norm);
      accepted.push({ path, expected, group: f.group });
    }
    repo.transaction(() => {
      for (const file of accepted) {
        jobIds.push(repo.createJob("import_file", null, { ...file, destination, ...(booth ? { booth } : {}) }, 5).id);
      }
    });
    return { jobIds, duplicates, legacy: false };
  }
  const paths = Array.isArray(body?.paths) ? body.paths.map(String) : [];
  const jobIds = paths.map((p) => repo.createJob("import_file", null, { path: p, legacy: true }, 5).id);
  return { jobIds, duplicates: [], legacy: true };
}

function importDestination(value: unknown): string {
  const path = typeof value === "string" ? value.trim() : "";
  if (!isAbsolute(path)) throw invalid("INVALID_DESTINATION", "请选择绝对路径作为导入目录");
  try {
    if (statSync(path).isDirectory()) return path;
  } catch { /* invalid destination */ }
  throw invalid("INVALID_DESTINATION", "导入目录不存在或无法访问");
}

/** Copies a verified source without overwriting any existing file. A retry may reuse identical bytes. */
export async function copyAcceptedFile(file: AcceptedFile, destination: string, checkOwner: (target: string) => void, signal?: AbortSignal): Promise<string> {
  const requestedDir = resolve(importDestination(destination));
  const dir = await realpath(requestedDir);
  const source = await realpath(file.path);
  const target = join(dir, basename(file.path));
  const registeredPath = join(requestedDir, basename(file.path));
  checkOwner(registeredPath);
  if (registeredPath !== target) checkOwner(target);
  if (target === source) return registeredPath;
  const scratch = await mkdtemp(join(dir, ".assetvault-import-"));
  try {
    const tempFile = join(scratch, "content");
    await copyFile(source, tempFile);
    signal?.throwIfAborted();
    const expected = file.expected;
    const snapshot = await sha256FileChunked(tempFile, { signal });
    const current = await stat(source);
    if (snapshot.bytes !== expected.size || current.size !== expected.size || current.mtime.getTime() !== Date.parse(expected.mtime)
      || (expected.sha256 && snapshot.sha256 !== expected.sha256.toLowerCase())) {
      throw new AppError("CONFLICT", "预检后源文件发生变化，请重新预检", 409, { code: "PRECHECK_STALE" });
    }
    if (await realpath(requestedDir) !== dir) throw invalid("INVALID_DESTINATION", "导入目录已变化，请重新选择");
    checkOwner(registeredPath);
    if (registeredPath !== target) checkOwner(target);
    try {
      try { await link(tempFile, target); }
      catch (error) {
        if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await copyFile(tempFile, target, constants.COPYFILE_EXCL);
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const targetStat = await lstat(target);
      const existing = targetStat.isFile() && targetStat.size === expected.size
        ? await sha256FileChunked(target, { signal }).catch(() => null) : null;
      if (!existing || existing.sha256 !== snapshot.sha256) {
        throw new AppError("CONFLICT", "导入目录已有不同内容的同名文件：" + basename(target), 409, { code: "DESTINATION_EXISTS" });
      }
    }
    return registeredPath;
  } finally { await rm(scratch, { recursive: true, force: true }).catch(() => {}); }
}

/**
 * 执行期重验单个接受文件：size+mtime 必须一致；`expected.sha256` 存在时当次强制重算。
 * 任何不一致（含文件消失/变成目录）→ `PRECHECK_STALE`，调用方不得登记。
 */
export async function verifyAcceptedFile(deps: { repo: Repo }, f: AcceptedFile): Promise<AcceptedFileVerifyResult> {
  // 本函数只验文件身份（size/mtime/sha256），不判归属：归属需要目标 itemId，由
  // verifyExpectedOrThrow / shouldSkipForOwnerConflict 在拿到目标后检查。
  void deps;
  const expected = expectedOf(f);
  if (!expected) return { ok: false, reason: "PRECHECK_STALE" };
  let st;
  try { st = statSync(f.path); } catch { return { ok: false, reason: "PRECHECK_STALE" }; }
  if (!st.isFile()) return { ok: false, reason: "PRECHECK_STALE" };
  if (st.size !== expected.size) return { ok: false, reason: "PRECHECK_STALE" };
  const expectedMs = Date.parse(expected.mtime);
  if (!Number.isFinite(expectedMs) || st.mtime.getTime() !== expectedMs) return { ok: false, reason: "PRECHECK_STALE" };
  if (expected.sha256) {
    const actual = (await sha256FileChunked(f.path)).sha256;
    if (actual.toLowerCase() !== String(expected.sha256).toLowerCase()) return { ok: false, reason: "PRECHECK_STALE" };
    return { ok: true, verified: "sha256" };
  }
  return { ok: true, verified: "metadata" };
}

/**
 * 同步路由（`POST /api/items/:id/assets`）用：先按 expected 重验（可选），再查 `path_norm` 归属。
 * 不匹配 → 409 `PRECHECK_STALE`；属于另一个 item → 409 `PATH_OWNED_BY_OTHER_ITEM`（带 details）。
 */
export async function verifyExpectedOrThrow(deps: { repo: Repo }, itemId: number, path: string, expected?: AcceptedFileExpected): Promise<void> {
  if (expected) {
    const v = await verifyAcceptedFile(deps, { path, expected });
    if (!v.ok) throw new AppError("CONFLICT", `precheck stale: ${path}`, 409, { code: "PRECHECK_STALE" });
  }
  const ex = deps.repo.getAssetByPathNorm(normalizePath(path));
  if (ex && ex.item_id !== itemId) {
    throw new AppError("CONFLICT", `path owned by item ${ex.item_id}: ${path}`, 409,
      { code: "PATH_OWNED_BY_OTHER_ITEM", itemId: ex.item_id, assetId: ex.id });
  }
}

function isVersionLinksError(e: unknown): boolean {
  return e instanceof AppError && e.details?.code === "ASSET_HAS_VERSION_LINKS";
}

/** 该 asset 是否带版本关系（§9.1：只有带关系的跨 owner 冲突才跳过）。 */
function hasVersionLinks(repo: Repo, assetId: number): boolean {
  try {
    // 复用共享检查：同 owner 早退；跨 owner 且带关系才抛 ASSET_HAS_VERSION_LINKS。
    repo.assertAssetOwnerChange(assetId, -1, { merge: false });
    return false;
  } catch (e) {
    if (isVersionLinksError(e)) return true;
    throw e;
  }
}

/**
 * 批次登记前的归属门（§9.1）：只有“跨 owner 且该 asset 有 version links”才跳过该文件。
 * 无 link 不跳过（保持旧 upsert 改 owner 语义）；同 owner 不跳过。
 * `itemId === null` 表示“新建 item 意图”：任何既有 owner 都算跨 owner。
 */
export function shouldSkipForOwnerConflict(repo: Repo, itemId: number | null, pathNorm: string): OwnerConflictResult {
  const ex = repo.getAssetByPathNorm(normalizePath(pathNorm));
  if (!ex) return { skip: false };
  if (itemId !== null && ex.item_id === itemId) return { skip: false };
  if (!hasVersionLinks(repo, ex.id)) return { skip: false };
  return { skip: true, itemId: ex.item_id, assetId: ex.id };
}

/**
 * 新 `files` 形状的严格归属门（N3）：在同步事务内、任何 createItem/registerAssets 之前调用。
 * 目标 item 已知 → 同 owner 幂等；目标为“新建 item 意图”（null）→ 任何既有 owner 都是冲突。
 * 冲突抛 `CONFLICT`/409/`PATH_OWNED_BY_OTHER_ITEM`（带 itemId/assetId），调用方不得登记。
 */
export function assertNoForeignOwner(repo: Repo, itemId: number | null, pathNorm: string): void {
  const ex = repo.getAssetByPathNorm(normalizePath(pathNorm));
  if (!ex) return;
  if (itemId !== null && ex.item_id === itemId) return;
  throw new AppError("CONFLICT", `path owned by item ${ex.item_id}: ${pathNorm}`, 409,
    { code: "PATH_OWNED_BY_OTHER_ITEM", itemId: ex.item_id, assetId: ex.id });
}
