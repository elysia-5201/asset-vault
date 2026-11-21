/**
 * Unity MCP 一键安装：纯核心（工程路径 / manifest / 前置条件）。
 *
 * 纯模块：不注册 HTTP、不访问真实 Unity、不写真实工程、不联网、不安装任何工具。
 * 所有 fs 操作只作用于调用方传入的路径；测试用自有 TMP 合成工程。
 * 错误外层复用 INVALID_INPUT（422），子码 details.code = UNITY_INSTALL_*。
 */
import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { access as accessCb } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { AppError } from "../../../../packages/core/src/contracts";
import { isSubPath, normalizePath } from "../../../../packages/core/src/pathnorm";

export type UnityInstallChange = "add" | "replace" | "none" | "conflict";
export type UnityInstallPrereqId = "unity_version" | "uv" | "git" | "writable" | "editor";
export type UnityInstallPrereqStatus = "ok" | "missing" | "unknown" | "mismatch";

export interface UnityInstallPrerequisite { id: UnityInstallPrereqId; status: UnityInstallPrereqStatus; detail: string }

export interface CanonicalProject {
  path: string; pathNorm: string; name: string; unityVersion: string;
  manifestPath: string; projectVersionPath: string;
}

export interface ManifestSnapshot { bytes: Buffer; text: string; json: Record<string, unknown>; hash: string }

export interface PackageState {
  current: null | { value: string; version: string | null; source: "git" | "local" | "registry" | "unknown" };
  change: UnityInstallChange;
}

export const UNITY_MCP_PACKAGE_ID = "com.coplaydev.unity-mcp";
export const UNITY_MCP_PACKAGE_VERSION = "10.0.0";
export const UNITY_MCP_PACKAGE_URL = "https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#v10.0.0";
/** 预览 TTL：10 分钟（spec §7）。 */
export const UNITY_INSTALL_TTL_MS = 10 * 60 * 1000;

const projectInvalid = (message: string): AppError =>
  new AppError("INVALID_INPUT", message, 422, { code: "UNITY_INSTALL_PROJECT_INVALID" });
const versionUnsupported = (message: string): AppError =>
  new AppError("INVALID_INPUT", message, 422, { code: "UNITY_INSTALL_VERSION_UNSUPPORTED" });
const manifestUnsafe = (message: string): AppError =>
  new AppError("INVALID_INPUT", message, 422, { code: "UNITY_INSTALL_MANIFEST_UNSAFE" });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 普通目录：存在、是目录、且自身不是符号链接（root 别名允许，包目录外移不允许）。 */
function assertPlainDir(p: string, label: string): void {
  let st;
  try { st = lstatSync(p); } catch { throw projectInvalid("缺少 " + label + " 目录: " + p); }
  if (st.isSymbolicLink()) throw projectInvalid(label + " 不能是符号链接: " + p);
  if (!st.isDirectory()) throw projectInvalid(label + " 不是目录: " + p);
}

/** 普通文件：存在、是普通文件、且自身不是符号链接。 */
function assertPlainFile(p: string, label: string): void {
  let st;
  try { st = lstatSync(p); } catch { throw projectInvalid("缺少 " + label + ": " + p); }
  if (st.isSymbolicLink()) throw projectInvalid(label + " 不能是符号链接: " + p);
  if (!st.isFile()) throw projectInvalid(label + " 不是普通文件: " + p);
}

/**
 * 路径相等：win32 走 normalizePath（大小写不敏感）；其它平台保留大小写。
 * 纯字符串规则，不代表真实 NTFS 行为（Windows 条件未实测，UNKNOWN）。
 */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (platform === "win32") return normalizePath(a) === normalizePath(b);
  const norm = (p: string): string => {
    let s = p.replace(/\\/g, "/").normalize("NFC");
    s = s.replace(/\/{2,}/g, "/");
    if (s.length > 1) s = s.replace(/\/+$/, "") || "/";
    return s;
  };
  return norm(a) === norm(b);
}

/** 解析 ProjectVersion.txt 的 m_EditorVersion；缺失返回 ""（由调用方判不支持）。 */
export function parseUnityVersion(projectVersionText: string): string {
  if (typeof projectVersionText !== "string") return "";
  const m = /^\s*m_EditorVersion:\s*(\S+)\s*$/m.exec(projectVersionText);
  return m ? m[1] : "";
}

/** Unity >= 2021.3（含 Unity 6 的 6000.x）。 */
export function isSupportedUnityVersion(version: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(String(version ?? ""));
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > 2021 || (major === 2021 && minor >= 3);
}

/**
 * 规范化工程路径：绝对路径 → realpath（允许 root 别名）→ 校验 Packages/ProjectSettings
 * 不是符号链接、manifest/ProjectVersion 是普通文件、manifest 解析后仍在工程内。
 */
export function canonicalProjectPath(raw: string): CanonicalProject {
  if (typeof raw !== "string" || raw.trim() === "") throw projectInvalid("projectPath 必填");
  if (!isAbsolute(raw)) throw projectInvalid("projectPath 必须是绝对路径: " + raw);
  let projectReal: string;
  try { projectReal = realpathSync(raw); } catch { throw projectInvalid("工程路径不存在或不可解析: " + raw); }
  let st;
  try { st = statSync(projectReal); } catch { throw projectInvalid("工程路径不可读: " + raw); }
  if (!st.isDirectory()) throw projectInvalid("工程路径不是目录: " + raw);

  const packagesDir = join(projectReal, "Packages");
  const settingsDir = join(projectReal, "ProjectSettings");
  assertPlainDir(packagesDir, "Packages");
  assertPlainDir(settingsDir, "ProjectSettings");

  const manifestPath = join(packagesDir, "manifest.json");
  const projectVersionPath = join(settingsDir, "ProjectVersion.txt");
  assertPlainFile(manifestPath, "Packages/manifest.json");
  assertPlainFile(projectVersionPath, "ProjectSettings/ProjectVersion.txt");

  let manifestReal: string;
  try { manifestReal = realpathSync(manifestPath); } catch { throw projectInvalid("manifest 不可解析: " + manifestPath); }
  if (!isSubPath(manifestReal, projectReal)) throw projectInvalid("manifest 解析到工程外: " + manifestReal);

  const unityVersion = parseUnityVersion(readFileSync(projectVersionPath, "utf8"));
  if (!unityVersion) throw versionUnsupported("ProjectVersion.txt 缺少 m_EditorVersion: " + projectVersionPath);

  return {
    path: projectReal, pathNorm: normalizePath(projectReal), name: basename(projectReal),
    unityVersion, manifestPath, projectVersionPath,
  };
}

/** 读 manifest 原始字节 + 文本 + JSON + sha256（拒绝符号链接/非普通文件/非对象 JSON）。 */
export function readManifest(manifestPath: string): ManifestSnapshot {
  assertPlainFile(manifestPath, "manifest.json");
  const bytes = readFileSync(manifestPath);
  const text = bytes.toString("utf8");
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw manifestUnsafe("manifest.json 不是合法 JSON: " + manifestPath); }
  if (!isPlainObject(parsed)) throw manifestUnsafe("manifest.json 顶层必须是对象: " + manifestPath);
  return { bytes, text, json: parsed, hash: createHash("sha256").update(bytes).digest("hex") };
}

function sourceOf(value: string): "git" | "local" | "registry" | "unknown" {
  if (/^file:/i.test(value) || value.startsWith(".") || value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)) return "local";
  if (/\.git(\?|#|$)/.test(value) || /^git[+@]/.test(value) || /^https?:\/\//.test(value)) return "git";
  if (/^\d+\.\d+\.\d+/.test(value)) return "registry";
  return "unknown";
}

function versionOf(value: string): string | null {
  const hash = value.indexOf("#");
  if (hash >= 0) {
    const frag = value.slice(hash + 1).trim();
    return frag ? frag.replace(/^v/i, "") : null;
  }
  if (/^\d+\.\d+\.\d+/.test(value)) return value;
  return null;
}

/**
 * 目标依赖当前状态：
 * - 无 dependencies / 无该键 → add；
 * - 同 URL → none；本地路径或 dependencies 非对象 → conflict；
 * - 同包在别的 key 也指向 unity-mcp → conflict（保守，不静默覆盖）；
 * - 其它值（不同版本/registry）→ replace。
 */
export function detectPackage(manifest: Record<string, unknown>): PackageState {
  const deps = manifest?.dependencies;
  if (deps === undefined) return { current: null, change: "add" };
  if (!isPlainObject(deps)) return { current: null, change: "conflict" };
  const value = deps[UNITY_MCP_PACKAGE_ID];
  const current = typeof value === "string"
    ? { value, version: versionOf(value), source: sourceOf(value) }
    : null;
  // spec §7：同包在别的 key 也指向 unity-mcp → conflict；canonical 缺键时同样要查（先于 add 判定）。
  for (const [k, v] of Object.entries(deps)) {
    if (k === UNITY_MCP_PACKAGE_ID) continue;
    if (typeof v === "string" && v.includes("unity-mcp")) return { current, change: "conflict" };
  }
  if (value === undefined) return { current: null, change: "add" };
  if (typeof value !== "string" || current === null) return { current: null, change: "conflict" };
  if (current.source === "local") return { current, change: "conflict" };
  if (value === UNITY_MCP_PACKAGE_URL) return { current, change: "none" };
  return { current, change: "replace" };
}

/** 从原文探测缩进（2/4 空格或 tab）；默认 2 空格。 */
function detectIndent(text: string): string {
  const m = /\n([ \t]+)"/.exec(text);
  if (!m) return "  ";
  const ws = m[1];
  if (ws.startsWith("\t")) return "\t";
  return ws.length >= 4 ? "    " : "  ";
}

/**
 * 构建新 manifest 文本：只改 dependencies[packageId]，保留 BOM、缩进、EOL、尾换行与其它键。
 * dependencies 非对象 / JSON 非法 → UNITY_INSTALL_MANIFEST_UNSAFE。
 */
export function buildManifestText(original: string, packageId: string, targetUrl: string): string {
  const bom = original.startsWith("\uFEFF");
  const body = bom ? original.slice(1) : original;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw manifestUnsafe("manifest.json 不是合法 JSON"); }
  if (!isPlainObject(parsed)) throw manifestUnsafe("manifest.json 顶层必须是对象");
  const deps = parsed.dependencies;
  if (deps !== undefined && !isPlainObject(deps)) throw manifestUnsafe("dependencies 必须是对象");
  const nextDeps: Record<string, unknown> = { ...(deps as Record<string, unknown> | undefined) };
  nextDeps[packageId] = targetUrl;
  const next: Record<string, unknown> = { ...parsed, dependencies: nextDeps };

  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  let out = JSON.stringify(next, null, detectIndent(body));
  if (eol === "\r\n") out = out.replace(/\n/g, "\r\n");
  if (body.endsWith("\n")) out += eol;
  return (bom ? "\uFEFF" : "") + out;
}

/** 只输出目标依赖行的 -/+（不引入 diff 依赖，不含文件头）。 */
export function diffManifest(before: string, after: string): string {
  const pick = (text: string): string | null => {
    for (const line of text.split(/\r?\n/)) {
      if (line.includes('"' + UNITY_MCP_PACKAGE_ID + '"')) return line;
    }
    return null;
  };
  const b = pick(before);
  const a = pick(after);
  if (b === a) return "";
  const out: string[] = [];
  if (b !== null) out.push("-" + b);
  if (a !== null) out.push("+" + a);
  return out.join("\n");
}

function defaultExecFile(file: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFileCb(file, args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout ?? "") });
    });
  });
}

async function defaultAccess(p: string): Promise<void> {
  await accessCb(p, constants.W_OK);
}

async function probeTool(
  exec: (file: string, args: string[]) => Promise<{ stdout: string }>,
  id: "uv" | "git",
  label: string,
  missingDetail: string,
): Promise<UnityInstallPrerequisite> {
  try {
    await exec(id, ["--version"]);
    return { id, status: "ok", detail: label + " 可用" };
  } catch {
    return { id, status: "missing", detail: missingDetail };
  }
}

/**
 * 前置条件（顺序固定：unity_version, uv, git, writable, editor）。
 * 只调用注入的 execFile/access（默认 uv --version / git --version / W_OK），不主动连接 Unity。
 * 无 editorProjectPath → unknown（不伪 ok、也不阻断安装）；错工程 → mismatch（warning 语义）。
 */
export async function checkPrerequisites(input: {
  projectPath: string;
  unityVersion: string;
  editorProjectPath?: string | null;
  execFile?: (file: string, args: string[]) => Promise<{ stdout: string }>;
  access?: (p: string) => Promise<void>;
}): Promise<UnityInstallPrerequisite[]> {
  const exec = input.execFile ?? defaultExecFile;
  const access = input.access ?? defaultAccess;
  const out: UnityInstallPrerequisite[] = [];

  out.push(isSupportedUnityVersion(input.unityVersion)
    ? { id: "unity_version", status: "ok", detail: "Unity " + input.unityVersion + " >= 2021.3" }
    : { id: "unity_version", status: "missing", detail: "需要 Unity >= 2021.3，当前 " + (input.unityVersion || "未知") });

  out.push(await probeTool(exec, "uv", "uv", "未找到 uv（请先安装 uv；本工具不自动安装）"));
  out.push(await probeTool(exec, "git", "git", "未找到 git（UPM 拉取 git 包需要 git）"));

  const packagesDir = join(input.projectPath, "Packages");
  const manifestPath = join(packagesDir, "manifest.json");
  // apply 是 Packages 目录下临时文件 + rename：目录与 manifest 两门都要过（保守跨平台，不试写/不 chmod）。
  let writableFailure: string | null = null;
  try { await access(packagesDir); } catch { writableFailure = "Packages 目录不可写: " + packagesDir; }
  if (!writableFailure) {
    try { await access(manifestPath); } catch { writableFailure = "manifest 不可写: " + manifestPath; }
  }
  out.push(writableFailure
    ? { id: "writable", status: "missing", detail: writableFailure }
    : { id: "writable", status: "ok", detail: "Packages 目录与 manifest 均可写" });

  const editor = input.editorProjectPath;
  if (!editor) {
    out.push({ id: "editor", status: "unknown", detail: "未提供已打开 Editor 的工程信息（不主动连接 Unity）" });
  } else if (samePath(editor, input.projectPath)) {
    out.push({ id: "editor", status: "ok", detail: "已打开 Editor 的工程与目标一致" });
  } else {
    out.push({ id: "editor", status: "mismatch", detail: "已打开 Editor 的是另一个工程: " + editor + "（安装仍可继续，之后需显式 probe）" });
  }

  return out;
}
