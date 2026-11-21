/**
 * Unity 安装：只读 probe 与 status（T3）。
 *
 * - statusInstall 只读 manifest / packages-lock.json / 上次 probe JSON，**零 Unity 调用**。
 * - probeInstall 只在显式调用时只读 execute_code（Editor 信息 + 编译标志），
 *   不 ImportPackage / Refresh / 触发真实编译 / 装包；错工程不查编译。
 * - 工程路径来自服务端 preview/op，不接受客户端路径。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "../../../../packages/core/src/contracts";
import {
  canonicalProjectPath, detectPackage, readManifest, samePath,
  UNITY_MCP_PACKAGE_ID, UNITY_MCP_PACKAGE_VERSION,
} from "./unity-install-core";
import { getOperation, type UnityInstallDeps } from "./unity-install";
import { unityEditorInfo, type UnityEditorInfo, type UnityMcp } from "./unity";

export interface UnityInstallProbe {
  projectPath: string;
  editor: UnityEditorInfo | null;
  projectMatch: boolean;
  compile: "ok" | "errors" | "unknown";
  bridge: "connected" | "editor_not_open" | "project_mismatch" | "unknown";
  tool: "compatible" | "incompatible" | "unknown";
  server: "connected" | "unreachable" | "unknown";
  warnings: string[];
}

export interface UnityInstallStatus {
  projectPath: string;
  projectName: string;
  unityVersion: string;
  packageId: string;
  targetVersion: string;
  config: "applied" | "not_applied" | "conflict";
  upm: "resolved" | "pending" | "unknown";
  compile: "ok" | "errors" | "unknown";
  bridge: "connected" | "editor_not_open" | "project_mismatch" | "unknown";
  tool: "compatible" | "incompatible" | "unknown";
  server: "connected" | "unreachable" | "unknown";
  warnings: string[];
}

const probeFile = (dataDir: string, projectPathNorm: string): string =>
  join(dataDir, "unity-install", "probe", createHash("sha256").update(projectPathNorm).digest("hex").slice(0, 32) + ".json");

function writeProbe(deps: UnityInstallDeps, probe: UnityInstallProbe): void {
  try {
    const norm = canonicalProjectPath(probe.projectPath).pathNorm;
    const file = probeFile(deps.dataDir, norm);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(probe, null, 2));
  } catch { /* 证据落盘失败不影响 probe 结果 */ }
}

function readProbe(deps: UnityInstallDeps, projectPathNorm: string): UnityInstallProbe | null {
  const file = probeFile(deps.dataDir, projectPathNorm);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<UnityInstallProbe>;
    if (!raw || typeof raw !== "object") return null;
    const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
      typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
    return {
      projectPath: String(raw.projectPath ?? ""),
      editor: (raw.editor as UnityEditorInfo | null) ?? null,
      projectMatch: raw.projectMatch === true,
      compile: pick(raw.compile, ["ok", "errors", "unknown"] as const, "unknown"),
      bridge: pick(raw.bridge, ["connected", "editor_not_open", "project_mismatch", "unknown"] as const, "unknown"),
      tool: pick(raw.tool, ["compatible", "incompatible", "unknown"] as const, "unknown"),
      server: pick(raw.server, ["connected", "unreachable", "unknown"] as const, "unknown"),
      warnings: Array.isArray(raw.warnings) ? raw.warnings.map(String) : [],
    };
  } catch { return null; }
}

/** 工程路径只从服务端 preview/op 取（不接客户端路径）。 */
function resolveProbeProject(deps: UnityInstallDeps, input: { previewId?: string; operationId?: string }): string {
  if (input.operationId) return getOperation(deps, input.operationId).projectPath;
  if (input.previewId) {
    const file = join(deps.dataDir, "unity-install", "previews", input.previewId + ".json");
    let raw: string;
    try { raw = readFileSync(file, "utf8"); }
    catch { throw new AppError("NOT_FOUND", "预览不存在: " + input.previewId, 404, { code: "UNITY_INSTALL_PREVIEW_NOT_FOUND" }); }
    let json: unknown;
    try { json = JSON.parse(raw); }
    catch { throw new AppError("INVALID_INPUT", "预览文件损坏", 422, { code: "UNITY_INSTALL_PREVIEW_INVALID" }); }
    const path = (json as { project?: { path?: unknown } })?.project?.path;
    if (typeof path !== "string" || path === "") {
      throw new AppError("INVALID_INPUT", "预览缺少工程路径", 422, { code: "UNITY_INSTALL_PREVIEW_INVALID" });
    }
    return path;
  }
  throw new AppError("INVALID_INPUT", "需要 previewId 或 operationId", 400, { code: "UNITY_INSTALL_INVALID_ID" });
}

/** 只读编译标志（EditorUtility.scriptCompilationFailed）；取不到 → unknown，不伪 ok。 */
async function compileState(client: UnityMcp): Promise<"ok" | "errors" | "unknown"> {
  try {
    const raw = await client.csharp("return EditorUtility.scriptCompilationFailed ? \"1\" : \"0\";");
    const v = String(raw).trim();
    if (v === "1") return "errors";
    if (v === "0") return "ok";
    return "unknown";
  } catch { return "unknown"; }
}

function toolState(tools: Array<{ name: string; inputSchema?: unknown }>): "compatible" | "incompatible" | "unknown" {
  const exec = tools.find((t) => t.name === "execute_code");
  if (!exec) return "incompatible";
  const schema = exec.inputSchema as { properties?: Record<string, unknown> } | undefined;
  const props = schema?.properties;
  if (!props || typeof props !== "object") return "incompatible";
  return props.action && props.code && props.safety_checks ? "compatible" : "incompatible";
}

/**
 * 显式只读 probe：server → tool → editor → projectMatch → compile。
 * 错工程只报 project_mismatch，不查编译；任何取不到的状态保持 unknown。
 */
export async function probeInstall(
  deps: UnityInstallDeps,
  input: { previewId?: string; operationId?: string },
): Promise<UnityInstallProbe> {
  const projectPath = resolveProbeProject(deps, input);
  const client = deps.unityClient?.();
  if (!client) {
    const probe: UnityInstallProbe = {
      projectPath, editor: null, projectMatch: false, compile: "unknown",
      bridge: "unknown", tool: "unknown", server: "unknown", warnings: ["未配置 Unity MCP 客户端"],
    };
    writeProbe(deps, probe);
    return probe;
  }

  let server: UnityInstallProbe["server"] = "unknown";
  try { await client.connect(); server = "connected"; } catch { server = "unreachable"; }
  if (server !== "connected") {
    const probe: UnityInstallProbe = {
      projectPath, editor: null, projectMatch: false, compile: "unknown",
      bridge: "unknown", tool: "unknown", server, warnings: ["Unity MCP 不可达"],
    };
    writeProbe(deps, probe);
    return probe;
  }

  let tool: UnityInstallProbe["tool"] = "unknown";
  try { tool = toolState(await client.listTools()); } catch { tool = "unknown"; }

  let editor: UnityEditorInfo | null = null;
  try { editor = await unityEditorInfo(client); } catch { editor = null; }
  if (!editor) {
    const probe: UnityInstallProbe = {
      projectPath, editor: null, projectMatch: false, compile: "unknown",
      bridge: "editor_not_open", tool, server, warnings: ["Editor 未打开或不可达"],
    };
    writeProbe(deps, probe);
    return probe;
  }

  const projectMatch = samePath(editor.projectPath, projectPath);
  if (!projectMatch) {
    const probe: UnityInstallProbe = {
      projectPath, editor, projectMatch: false, compile: "unknown",
      bridge: "project_mismatch", tool, server,
      warnings: ["已打开 Editor 是另一个工程: " + editor.projectPath],
    };
    writeProbe(deps, probe);
    return probe;
  }

  // 编译进行中时旧编译标志可能是上一轮结果：保持 unknown，且不额外读取该标志。
  const compile = editor.isCompiling ? "unknown" : await compileState(client);
  const probe: UnityInstallProbe = {
    projectPath, editor, projectMatch: true, compile, bridge: "connected", tool, server,
    warnings: compile === "unknown" ? ["未能取得编译状态"] : [],
  };
  writeProbe(deps, probe);
  return probe;
}

function upmState(projectPath: string): "resolved" | "pending" | "unknown" {
  const lock = join(projectPath, "Packages", "packages-lock.json");
  if (!existsSync(lock)) return "unknown";
  try {
    const json = JSON.parse(readFileSync(lock, "utf8")) as { dependencies?: Record<string, unknown> };
    const deps = json?.dependencies;
    if (!deps || typeof deps !== "object") return "pending";
    return UNITY_MCP_PACKAGE_ID in deps ? "resolved" : "pending";
  } catch { return "unknown"; }
}

/** 只读状态：manifest + packages-lock + 上次 probe JSON；不调用 Unity。 */
export function statusInstall(deps: UnityInstallDeps, projectPath: string): UnityInstallStatus {
  const project = canonicalProjectPath(projectPath);
  const manifest = readManifest(project.manifestPath);
  const pkg = detectPackage(manifest.json);
  const config: UnityInstallStatus["config"] =
    pkg.change === "none" ? "applied" : pkg.change === "conflict" ? "conflict" : "not_applied";
  const last = readProbe(deps, project.pathNorm);
  return {
    projectPath: project.path,
    projectName: project.name,
    unityVersion: project.unityVersion,
    packageId: UNITY_MCP_PACKAGE_ID,
    targetVersion: UNITY_MCP_PACKAGE_VERSION,
    config,
    upm: upmState(project.path),
    compile: last?.compile ?? "unknown",
    bridge: last?.bridge ?? "unknown",
    tool: last?.tool ?? "unknown",
    server: last?.server ?? "unknown",
    warnings: last?.warnings ?? [],
  };
}
