/**
 * Unity MCP 一键安装：预览、备份、应用、回滚、恢复（T2）。
 *
 * 只写 dataDir/unity-install/** 与目标工程 Packages/manifest.json；不调用 Unity、不联网、不装包。
 * 所有 DB 无关；RecoveryDeps 不依赖 Repo。错误外层复用 INVALID_INPUT/NOT_FOUND/CONFLICT，
 * details.code = UNITY_INSTALL_*。
 */
import { createHash, randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AppError } from "../../../../packages/core/src/contracts";
import type { Repo } from "../db/repo";
import type { UnityMcp } from "./unity";
import {
  canonicalProjectPath, readManifest, detectPackage, buildManifestText, diffManifest,
  checkPrerequisites, isSupportedUnityVersion,
  UNITY_MCP_PACKAGE_ID, UNITY_MCP_PACKAGE_VERSION, UNITY_MCP_PACKAGE_URL, UNITY_INSTALL_TTL_MS,
  type CanonicalProject, type PackageState, type UnityInstallChange, type UnityInstallPrerequisite,
} from "./unity-install-core";

export interface UnityInstallDeps {
  dataDir: string;
  repo: Pick<Repo, "getSetting">;
  log?: (m: string) => void;
  now?: () => Date;
  fs?: Partial<typeof import("node:fs")>;
  execFile?: (file: string, args: string[]) => Promise<{ stdout: string }>;
  unityClient?: () => UnityMcp;
}

export interface RecoveryDeps {
  dataDir: string;
  log?: (m: string) => void;
  fs?: Partial<typeof import("node:fs")>;
  now?: () => Date;
}

export interface UnityInstallPreview {
  previewId: string;
  expiresAt: string;
  project: CanonicalProject & { manifestHash: string };
  package: { id: string; targetVersion: string; targetUrl: string; current: PackageState["current"]; change: UnityInstallChange };
  diff: string;
  backup: { dir: string; files: Array<{ path: string; sha256: string; bytes: number }> };
  prerequisites: UnityInstallPrerequisite[];
  warnings: string[];
  previewHash: string;
}

export interface UnityInstallApplyResult {
  operationId: string | null;
  status: "already_installed" | "config_applied";
  manifestHash: string;
  backupDir: string | null;
  warnings: string[];
}

export interface UnityInstallOperation {
  operationId: string;
  projectPath: string;
  projectPathNorm: string;
  packageId: string;
  targetVersion: string;
  targetUrl: string;
  status: "previewed" | "applying" | "rolling_back" | "config_applied" | "failed" | "conflict" | "rolled_back" | "interrupted" | "cancelled";
  createdAt: string;
  updatedAt: string;
  beforeHash: string;
  afterHash: string | null;
  plannedAfterHash: string | null;
  backupDir: string;
  steps: { config: string; upm: string; compile: string; bridge: string; tool: string; server: string };
  error?: string;
}

type FsLike = typeof import("node:fs");
type StoredPreview = UnityInstallPreview & { used?: boolean };

const locks = new Map<string, true>();

const err = (
  code: "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "UPSTREAM_ERROR",
  message: string,
  status: number,
  detailCode: string,
  extra?: Record<string, unknown>,
): AppError => new AppError(code, message, status, { code: detailCode, ...(extra ?? {}) });

function fsOf(deps: { fs?: Partial<FsLike> }): FsLike {
  if (!deps.fs) return nodeFs;
  return new Proxy(nodeFs, {
    get(target, prop, receiver) {
      const injected = deps.fs as unknown as Record<PropertyKey, unknown>;
      const v = injected[prop];
      return v !== undefined ? v : Reflect.get(target, prop, receiver);
    },
  }) as FsLike;
}

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
const nowOf = (deps: { now?: () => Date }): Date => deps.now?.() ?? new Date();
const iso = (deps: { now?: () => Date }): string => nowOf(deps).toISOString();

function safeId(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw)) {
    throw err("INVALID_INPUT", label + " 非法", 400, "UNITY_INSTALL_INVALID_ID");
  }
  return raw;
}

const previewFile = (dataDir: string, id: string): string => join(dataDir, "unity-install", "previews", id + ".json");
const operationFile = (dataDir: string, id: string): string => join(dataDir, "unity-install", "operations", id + ".json");

function writeJsonAtomic(f: FsLike, file: string, value: unknown): void {
  f.mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + randomUUID();
  f.writeFileSync(tmp, JSON.stringify(value, null, 2));
  f.renameSync(tmp, file);
}

function writeBytesAtomic(f: FsLike, file: string, bytes: Buffer): void {
  f.mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + randomUUID();
  f.writeFileSync(tmp, bytes);
  f.renameSync(tmp, file);
}

function readJson<T>(f: FsLike, file: string): T | null {
  if (!f.existsSync(file)) return null;
  try { return JSON.parse(f.readFileSync(file, "utf8")) as T; } catch { return null; }
}

function readFileHash(f: FsLike, file: string): string | null {
  if (!f.existsSync(file)) return null;
  return sha256(f.readFileSync(file));
}

function computePreviewHash(p: Omit<UnityInstallPreview, "previewHash">): string {
  return sha256(JSON.stringify({
    project: p.project,
    package: p.package,
    diff: p.diff,
    backup: p.backup,
    prerequisites: p.prerequisites,
    warnings: p.warnings,
  }));
}

function collectBackupFiles(f: FsLike, project: CanonicalProject): Array<{ path: string; sha256: string; bytes: number }> {
  const paths = [project.manifestPath, join(project.path, "Packages", "packages-lock.json"), project.projectVersionPath];
  const out: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const p of paths) {
    if (!f.existsSync(p)) continue;
    const bytes = f.readFileSync(p);
    out.push({ path: p, sha256: sha256(bytes), bytes: bytes.length });
  }
  return out;
}

function writePreview(f: FsLike, dataDir: string, preview: UnityInstallPreview): void {
  writeJsonAtomic(f, previewFile(dataDir, preview.previewId), { ...preview, used: false });
}

function readPreview(f: FsLike, dataDir: string, id: string): StoredPreview {
  const p = readJson<StoredPreview>(f, previewFile(dataDir, id));
  if (!p) throw err("NOT_FOUND", "预览不存在: " + id, 404, "UNITY_INSTALL_NOT_FOUND");
  return p;
}

function markPreviewUsed(f: FsLike, dataDir: string, id: string): void {
  const p = readPreview(f, dataDir, id);
  writeJsonAtomic(f, previewFile(dataDir, id), { ...p, used: true });
}

function writeOperation(f: FsLike, dataDir: string, op: UnityInstallOperation): void {
  writeJsonAtomic(f, operationFile(dataDir, op.operationId), op);
}

function readOperation(f: FsLike, dataDir: string, id: string): UnityInstallOperation {
  const op = readJson<UnityInstallOperation>(f, operationFile(dataDir, id));
  if (!op) throw err("NOT_FOUND", "操作不存在: " + id, 404, "UNITY_INSTALL_NOT_FOUND");
  return op;
}

function stripLeadingBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function deepEqualExceptTarget(beforeText: string, afterText: string, packageId: string): boolean {
  try {
    const before = JSON.parse(stripLeadingBom(beforeText)) as Record<string, unknown>;
    const after = JSON.parse(stripLeadingBom(afterText)) as Record<string, unknown>;
    const beforeDeps = { ...((before.dependencies ?? {}) as Record<string, unknown>) };
    const afterDeps = { ...((after.dependencies ?? {}) as Record<string, unknown>) };
    const targetOk = afterDeps[packageId] === UNITY_MCP_PACKAGE_URL;
    delete beforeDeps[packageId];
    delete afterDeps[packageId];
    return targetOk && isDeepStrictEqual({ ...before, dependencies: beforeDeps }, { ...after, dependencies: afterDeps });
  } catch {
    return false;
  }
}

const MAX_DIFF_LINES = 200;

function lineDiff(expected: string, actual: string): string {
  const a = expected.split(/\r?\n/);
  const b = actual.split(/\r?\n/);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push("-" + a[i]); i++; }
    else { out.push("+" + b[j]); j++; }
  }
  while (i < n) out.push("-" + a[i++]);
  while (j < m) out.push("+" + b[j++]);
  if (out.length > MAX_DIFF_LINES) return out.slice(0, MAX_DIFF_LINES).join("\n") + "\n... (diff truncated)";
  return out.join("\n");
}

function restoreIfCurrent(f: FsLike, manifestPath: string, afterHash: string, beforeBytes: Buffer): void {
  if (readFileHash(f, manifestPath) === afterHash) writeBytesAtomic(f, manifestPath, beforeBytes);
}

function createBackup(f: FsLike, project: CanonicalProject, op: UnityInstallOperation): void {
  f.mkdirSync(op.backupDir, { recursive: true });
  const files: Array<{ name: string; sha256: string; bytes: number }> = [];
  for (const src of [project.manifestPath, join(project.path, "Packages", "packages-lock.json"), project.projectVersionPath]) {
    if (!f.existsSync(src)) continue;
    const bytes = f.readFileSync(src);
    const name = basename(src);
    const dest = join(op.backupDir, name);
    writeBytesAtomic(f, dest, bytes);
    const hash = sha256(f.readFileSync(dest));
    if (hash !== sha256(bytes)) {
      throw err("CONFLICT", "备份校验失败: " + name, 409, "UNITY_INSTALL_BACKUP_FAILED", { operationId: op.operationId, backupDir: op.backupDir });
    }
    files.push({ name, sha256: hash, bytes: bytes.length });
  }
  writeJsonAtomic(f, join(op.backupDir, "meta.json"), {
    operationId: op.operationId, projectPath: op.projectPath, beforeHash: op.beforeHash,
    plannedAfterHash: op.plannedAfterHash, afterHash: null, status: "applying", files, createdAt: op.createdAt,
  });
}

function updateBackupMeta(f: FsLike, backupDir: string, patch: Record<string, unknown>): void {
  const file = join(backupDir, "meta.json");
  const meta = readJson<Record<string, unknown>>(f, file);
  if (!meta) return;
  writeJsonAtomic(f, file, { ...meta, ...patch });
}

export async function createPreview(deps: UnityInstallDeps, projectPath: string): Promise<UnityInstallPreview> {
  const f = fsOf(deps);
  const project = canonicalProjectPath(projectPath);
  if (!isSupportedUnityVersion(project.unityVersion)) {
    throw err("INVALID_INPUT", "需要 Unity >= 2021.3，当前 " + project.unityVersion, 422, "UNITY_INSTALL_VERSION_UNSUPPORTED");
  }
  const manifest = readManifest(project.manifestPath);
  const pkg = detectPackage(manifest.json);
  let diff = "";
  if (pkg.change !== "conflict") {
    const afterText = buildManifestText(manifest.text, UNITY_MCP_PACKAGE_ID, UNITY_MCP_PACKAGE_URL);
    diff = diffManifest(manifest.text, afterText);
  }
  const previewId = randomUUID();
  const now = nowOf(deps);
  const expiresAt = new Date(now.getTime() + UNITY_INSTALL_TTL_MS).toISOString();
  const backupDir = join(deps.dataDir, "unity-install", "backups", previewId);
  const backupFiles = collectBackupFiles(f, project);
  const prerequisites = await checkPrerequisites({
    projectPath: project.path, unityVersion: project.unityVersion, editorProjectPath: null, execFile: deps.execFile,
  });
  const warnings: string[] = [];
  const editor = prerequisites.find((p) => p.id === "editor");
  if (editor?.status === "unknown") warnings.push("Editor 未提供/未连接；安装后需显式 probe，不能把 unknown 当成功");
  if (editor?.status === "mismatch") warnings.push("已打开 Editor 是另一个工程；安装后需显式 probe");
  if (pkg.change === "conflict") warnings.push("manifest 存在冲突，不能应用");
  const base: Omit<UnityInstallPreview, "previewHash"> = {
    previewId, expiresAt,
    project: { ...project, manifestHash: manifest.hash },
    package: {
      id: UNITY_MCP_PACKAGE_ID, targetVersion: UNITY_MCP_PACKAGE_VERSION, targetUrl: UNITY_MCP_PACKAGE_URL,
      current: pkg.current, change: pkg.change,
    },
    diff,
    backup: { dir: backupDir, files: backupFiles },
    prerequisites,
    warnings,
  };
  const preview: UnityInstallPreview = { ...base, previewHash: computePreviewHash(base) };
  writePreview(f, deps.dataDir, preview);
  return preview;
}

export async function applyPreview(
  deps: UnityInstallDeps,
  input: { previewId: string; confirm: true; confirmReplace?: boolean },
): Promise<UnityInstallApplyResult> {
  const f = fsOf(deps);
  if (!input || input.confirm !== true) {
    throw err("INVALID_INPUT", "confirm 必须为 true", 400, "UNITY_INSTALL_CONFLICT");
  }
  const previewId = safeId(input.previewId, "previewId");
  const preview = readPreview(f, deps.dataDir, previewId);
  if (preview.used === true) {
    throw err("CONFLICT", "预览已使用", 409, "UNITY_INSTALL_PREVIEW_STALE");
  }
  const now = nowOf(deps);
  if (new Date(preview.expiresAt).getTime() <= now.getTime()) {
    throw err("CONFLICT", "预览已过期", 409, "UNITY_INSTALL_PREVIEW_EXPIRED");
  }
  if (computePreviewHash(preview) !== preview.previewHash) {
    throw err("CONFLICT", "预览哈希不一致", 409, "UNITY_INSTALL_PREVIEW_STALE");
  }
  const project = canonicalProjectPath(preview.project.path);
  if (project.pathNorm !== preview.project.pathNorm) {
    throw err("CONFLICT", "工程路径已变化", 409, "UNITY_INSTALL_PREVIEW_STALE");
  }
  const manifest = readManifest(project.manifestPath);
  if (manifest.hash !== preview.project.manifestHash) {
    throw err("CONFLICT", "manifest 在预览后已变化", 409, "UNITY_INSTALL_PREVIEW_STALE");
  }
  if (preview.package.change === "none") {
    return { operationId: null, status: "already_installed", manifestHash: manifest.hash, backupDir: null, warnings: preview.warnings };
  }
  if (preview.package.change === "conflict") {
    throw err("CONFLICT", "manifest 存在冲突，不能应用", 409, "UNITY_INSTALL_CONFLICT");
  }
  if (preview.package.change === "replace" && input.confirmReplace !== true) {
    throw err("CONFLICT", "替换现有版本需要 confirmReplace", 409, "UNITY_INSTALL_REPLACE_NOT_CONFIRMED");
  }

  const key = project.pathNorm;
  if (locks.has(key)) throw err("CONFLICT", "该工程正在应用", 409, "UNITY_INSTALL_LOCKED");
  locks.set(key, true);
  try {
    // 让并发第二 apply 能观察到本进程锁；无 I/O。
    await Promise.resolve();
    const operationId = randomUUID();
    const afterText = buildManifestText(manifest.text, UNITY_MCP_PACKAGE_ID, UNITY_MCP_PACKAGE_URL);
    const plannedAfterHash = sha256(Buffer.from(afterText));
    const backupDir = join(deps.dataDir, "unity-install", "backups", operationId);
    const createdAt = now.toISOString();
    const op: UnityInstallOperation = {
      operationId, projectPath: project.path, projectPathNorm: project.pathNorm,
      packageId: UNITY_MCP_PACKAGE_ID, targetVersion: UNITY_MCP_PACKAGE_VERSION, targetUrl: UNITY_MCP_PACKAGE_URL,
      status: "applying", createdAt, updatedAt: createdAt,
      beforeHash: manifest.hash, afterHash: null, plannedAfterHash, backupDir,
      steps: { config: "pending", upm: "pending", compile: "unknown", bridge: "unknown", tool: "unknown", server: "unknown" },
    };
    try {
      writeOperation(f, deps.dataDir, op);
    } catch {
      throw err("CONFLICT", "写前 journal 失败", 409, "UNITY_INSTALL_JOURNAL_FAILED", { operationId, backupDir, afterHash: null });
    }
    try {
      createBackup(f, project, op);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw err("CONFLICT", "备份失败", 409, "UNITY_INSTALL_BACKUP_FAILED", { operationId, backupDir });
    }
    try {
      markPreviewUsed(f, deps.dataDir, previewId);
    } catch {
      throw err("CONFLICT", "预览标记失败", 409, "UNITY_INSTALL_WRITE_FAILED", { operationId, backupDir });
    }
    try {
      writeBytesAtomic(f, project.manifestPath, Buffer.from(afterText));
    } catch {
      throw err("CONFLICT", "manifest 写入失败", 409, "UNITY_INSTALL_WRITE_FAILED", { operationId, backupDir });
    }
    const afterBytes = f.readFileSync(project.manifestPath);
    const afterHash = sha256(afterBytes);
    if (!deepEqualExceptTarget(manifest.text, afterBytes.toString("utf8"), UNITY_MCP_PACKAGE_ID)) {
      restoreIfCurrent(f, project.manifestPath, afterHash, manifest.bytes);
      throw err("CONFLICT", "写后 manifest 除目标键外发生变化", 409, "UNITY_INSTALL_WRITE_UNSAFE", { operationId, backupDir, afterHash });
    }
    try { updateBackupMeta(f, backupDir, { afterHash, status: "config_applied" }); } catch { /* meta 仅证据 */ }
    const applied: UnityInstallOperation = { ...op, status: "config_applied", afterHash, updatedAt: iso(deps) };
    try {
      writeOperation(f, deps.dataDir, applied);
    } catch {
      try { writeOperation(f, deps.dataDir, { ...applied, status: "interrupted", error: "post-write journal failed" }); } catch { /* journal 仍不可写 */ }
      throw err("CONFLICT", "写后 journal 失败", 409, "UNITY_INSTALL_JOURNAL_FAILED", { operationId, backupDir, afterHash });
    }
    return { operationId, status: "config_applied", manifestHash: afterHash, backupDir, warnings: preview.warnings };
  } finally {
    locks.delete(key);
  }
}

export function getOperation(deps: UnityInstallDeps, operationId: string): UnityInstallOperation {
  const f = fsOf(deps);
  return readOperation(f, deps.dataDir, safeId(operationId, "operationId"));
}

type RollbackBackup =
  | { ok: true; bytes: Buffer; text: string }
  | { ok: false; reason: string };

function readRollbackBackup(f: FsLike, op: UnityInstallOperation): RollbackBackup {
  const backupManifest = join(op.backupDir, "manifest.json");
  if (!f.existsSync(backupManifest)) return { ok: false, reason: "备份 manifest 缺失" };
  let bytes: Buffer;
  try { bytes = f.readFileSync(backupManifest); }
  catch { return { ok: false, reason: "备份 manifest 不可读" }; }
  if (sha256(bytes) !== op.beforeHash) return { ok: false, reason: "备份 manifest 哈希不匹配" };
  return { ok: true, bytes, text: bytes.toString("utf8") };
}

export function rollbackOperation(deps: UnityInstallDeps, operationId: string): UnityInstallOperation {
  const f = fsOf(deps);
  const id = safeId(operationId, "operationId");
  const op = readOperation(f, deps.dataDir, id);
  const manifestPath = join(op.projectPath, "Packages", "manifest.json");
  const backup = readRollbackBackup(f, op);

  const conflict = (expectedText: string | null, label: string, reason?: string): AppError => {
    let diff: string | undefined;
    let detail: string;
    if (expectedText !== null) {
      if (!f.existsSync(manifestPath)) {
        detail = "；差异不可用：当前 manifest 不存在";
      } else {
        let currentText: string;
        try { currentText = f.readFileSync(manifestPath, "utf8"); }
        catch {
          detail = "；差异不可用：当前 manifest 不可读";
          return err("CONFLICT", "拒绝回滚" + detail, 409, "UNITY_INSTALL_ROLLBACK_CONFLICT", { diffUnavailable: "当前 manifest 不可读" });
        }
        diff = lineDiff(expectedText, currentText);
        detail = diff
          ? "；差异（" + label + "）：\n" + diff
          : "；差异不可用：无行级差异（可能仅编码/换行不同）";
      }
    } else {
      const why = reason ?? "备份不可用";
      detail = "；差异不可用：" + why;
    }
    return err("CONFLICT", "拒绝回滚" + detail, 409, "UNITY_INSTALL_ROLLBACK_CONFLICT", {
      ...(diff ? { diff } : {}),
      ...(expectedText === null ? { diffUnavailable: reason ?? "备份不可用" } : {}),
    });
  };

  const expectedInstalled = (): string | null => {
    if (!backup.ok) return null;
    try { return buildManifestText(backup.text, op.packageId, op.targetUrl); }
    catch { return null; }
  };

  if (op.status === "rolled_back") {
    if (readFileHash(f, manifestPath) === op.beforeHash) return op;
    throw conflict(backup.ok ? backup.text : null, "预期回滚后（before） vs 当前", backup.ok ? undefined : backup.reason);
  }
  const afterHash = op.afterHash ?? op.plannedAfterHash;
  if (!afterHash) {
    throw conflict(expectedInstalled(), "预期安装（after） vs 当前", backup.ok ? "operation 缺少 afterHash/plannedAfterHash" : backup.reason);
  }
  if (readFileHash(f, manifestPath) !== afterHash) {
    throw conflict(expectedInstalled(), "预期安装（after） vs 当前", backup.ok ? undefined : backup.reason);
  }
  if (!backup.ok) throw conflict(null, "预期安装（after） vs 当前", backup.reason);
  const backupBytes = backup.bytes;
  if (sha256(backupBytes) !== op.beforeHash) throw conflict(null, "预期安装（after） vs 当前", "备份 manifest 哈希不匹配");
  const rolling: UnityInstallOperation = { ...op, status: "rolling_back", afterHash, updatedAt: iso(deps) };
  writeOperation(f, deps.dataDir, rolling);
  writeBytesAtomic(f, manifestPath, backupBytes);
  if (readFileHash(f, manifestPath) !== op.beforeHash) throw conflict(null, "预期安装（after） vs 当前", "回滚后 manifest 哈希不等于 beforeHash");
  const done: UnityInstallOperation = { ...rolling, status: "rolled_back", updatedAt: iso(deps) };
  writeOperation(f, deps.dataDir, done);
  return done;
}

export function cancelPreview(deps: UnityInstallDeps, previewId: string): { cancelled: true } {
  const f = fsOf(deps);
  const id = safeId(previewId, "previewId");
  const preview = readPreview(f, deps.dataDir, id);
  if (preview.used === true) {
    throw err("CONFLICT", "预览已用于应用，不能取消；请走回滚", 409, "UNITY_INSTALL_PREVIEW_STALE");
  }
  if (locks.has(preview.project.pathNorm)) {
    throw err("CONFLICT", "该工程正在应用，不能取消预览", 409, "UNITY_INSTALL_LOCKED");
  }
  try {
    f.unlinkSync(previewFile(deps.dataDir, id));
  } catch {
    throw err("CONFLICT", "取消预览失败", 409, "UNITY_INSTALL_WRITE_FAILED");
  }
  return { cancelled: true };
}

export async function recoverInterruptedOperations(deps: RecoveryDeps): Promise<{ recovered: number; conflicts: number }> {
  const f = fsOf(deps);
  const opsDir = join(deps.dataDir, "unity-install", "operations");
  let recovered = 0;
  let conflicts = 0;
  if (f.existsSync(opsDir)) {
    for (const name of f.readdirSync(opsDir)) {
      if (!name.endsWith(".json")) continue;
      let op: UnityInstallOperation;
      try { op = JSON.parse(f.readFileSync(join(opsDir, name), "utf8")) as UnityInstallOperation; } catch { continue; }
      if (op.status !== "applying" && op.status !== "rolling_back") continue;
      const manifestPath = join(op.projectPath, "Packages", "manifest.json");
      const current = readFileHash(f, manifestPath);
      const expectedAfter = op.afterHash ?? op.plannedAfterHash;
      let status: UnityInstallOperation["status"];
      let error: string | undefined;
      if (current !== null && expectedAfter !== null && current === expectedAfter) {
        status = "config_applied"; recovered++;
      } else if (current !== null && current === op.beforeHash) {
        status = "interrupted"; recovered++;
      } else {
        status = "conflict"; conflicts++;
        error = "manifest 与 before/after 都不一致";
      }
      try {
        writeOperation(f, deps.dataDir, {
          ...op, status, afterHash: status === "config_applied" ? expectedAfter : op.afterHash,
          updatedAt: iso(deps), ...(error ? { error } : {}),
        });
      } catch {
        deps.log?.("unity-install recovery: 写回失败 " + name);
      }
      deps.log?.("unity-install recovery: " + op.operationId + " -> " + status);
    }
  }
  const backupsDir = join(deps.dataDir, "unity-install", "backups");
  if (f.existsSync(backupsDir)) {
    for (const name of f.readdirSync(backupsDir)) {
      if (!f.existsSync(join(backupsDir, name, "meta.json"))) continue;
      if (!f.existsSync(join(opsDir, name + ".json"))) deps.log?.("unity-install recovery: orphan backup " + name);
    }
  }
  return { recovered, conflicts };
}
