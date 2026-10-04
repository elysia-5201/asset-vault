/**
 * Unity 编辑器桥：经 mcp-for-unity（Streamable HTTP，默认 127.0.0.1:8080/mcp）
 * 在**用户当前打开的那个 Unity 编辑器**里跑 C#，把素材包真正导入工程（不是只登记一行）。
 *
 * 为什么这里自己实现 MCP 客户端：MCP 是给 agent 的协议，本服务是 app 自己当客户端，
 * 只需要三件事——initialize → notifications/initialized → tools/call。
 * 端点优先取 settings.unity_mcp_url，缺省按 UNITY_MCP_URLS 逐个探测。
 */
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { listArchive, readArchiveEntry } from "../../../../packages/core/src/archive/list";
import type { Repo } from "../db/repo";

/** 本机两个已知的 Unity 桥（都只监听 127.0.0.1）。 */
export const UNITY_MCP_URLS = ["http://127.0.0.1:8080/mcp", "http://127.0.0.1:14523/mcp"];
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_NESTED_ZIPS = 2;

/** 取文件名：本服务可能在 WSL 里跑而路径是 Windows 形式，path.basename 在 POSIX 下不认反斜杠。 */
const baseName = (p: string): string => String(p).split(/[\\/]/).filter(Boolean).pop() ?? String(p);

export interface UnityEditorInfo {
  endpoint: string; serverName: string; dataPath: string; projectPath: string; projectName: string;
  unityVersion: string; isPlaying: boolean; isCompiling: boolean; scenePath: string;
}

export interface UnityPackageCandidate {
  /** 稳定 key：assetId + 包内路径，前端勾选后回传 */
  key: string; label: string; assetId: number; container: string;
  sourcePath: string; entryPath: string | null; innerEntryPath: string | null;
  size: number; note?: string;
}

/** SSE / 纯 JSON 两种响应都能解（Streamable HTTP 允许任一种）。 */
export function parseMcpBody(text: string): any {
  const t = String(text ?? "").trim();
  if (!t) return null;
  if (t.startsWith("{")) { try { return JSON.parse(t); } catch { return null; } }
  let last: string | null = null;
  for (const line of t.split(/\r?\n/)) if (line.startsWith("data:")) last = line.slice(5).trim();
  if (!last) return null;
  try { return JSON.parse(last); } catch { return null; }
}

let distroCache: string | null = null;
/** WSL 里跑服务、Windows 上跑 Unity 时，得把路径翻译成 Unity 能读的形式。 */
function wslDistro(): string {
  if (distroCache !== null) return distroCache;
  distroCache = process.env.WSL_DISTRO_NAME ?? "";
  if (!distroCache) {
    try {
      const out = execFileSync("wslpath", ["-w", "/"], { encoding: "utf8", timeout: 3000 }).trim();
      const m = /^\\+(?:wsl\$|wsl\.localhost)\\([^\\]+)\\/.exec(out);
      if (m) distroCache = m[1] ?? "";
    } catch { /* 不是 WSL 就算了 */ }
  }
  return distroCache;
}

/** 纯函数：Linux 绝对路径 → Unity 所在机器的路径（/mnt/c/... → C:\\...；其余 → \\\\wsl.localhost\\<distro>\\...）。 */
export function translateToHost(p: string, distro: string): string {
  if (!p.startsWith("/")) return p;
  const drv = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(p);
  if (drv) return drv[1]!.toUpperCase() + ":\\" + (drv[2] ?? "").replace(/\//g, "\\");
  return distro ? "\\\\wsl.localhost\\" + distro + p.replace(/\//g, "\\") : p;
}

/** 把本进程看到的绝对路径翻译成"Unity 所在机器"能打开的路径（Windows 原生直通；WSL 走 /mnt 或 \\wsl.localhost）。 */
export function toHostPath(p: string): string {
  if (process.platform !== "linux") return p;
  return translateToHost(p, wslDistro());
}

interface McpSession { url: string; sid: string; name: string; version: string }

/** 极简 MCP(Streamable HTTP) 客户端：一个进程一个会话，会话失效自动重连一次。 */
export class UnityMcp {
  private session: McpSession | null = null;
  private id = 1;
  constructor(private urls: string[] = UNITY_MCP_URLS, private timeoutMs = 120000) {}

  get endpoint(): string { return this.session?.url ?? this.urls[0] ?? UNITY_MCP_URLS[0]!; }
  get serverName(): string { return this.session?.name ?? ""; }

  private async post(url: string, payload: unknown, sid?: string | null): Promise<{ status: number; json: any; sid: string | null }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json", accept: "application/json, text/event-stream",
          ...(sid ? { "mcp-session-id": sid } : {}),
        },
        body: JSON.stringify(payload), signal: ac.signal,
      });
      const text = await res.text();
      return { status: res.status, json: parseMcpBody(text), sid: res.headers.get("mcp-session-id") };
    } finally { clearTimeout(timer); }
  }

  /** 探测并握手；force=true 时丢弃旧会话重连。 */
  async connect(force = false): Promise<McpSession> {
    if (this.session && !force) return this.session;
    this.session = null;
    const errors: string[] = [];
    for (const url of this.urls) {
      try {
        const r = await this.post(url, {
          jsonrpc: "2.0", id: this.id++,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "asset-vault", version: "0.1.0" } },
        });
        const info = r.json?.result?.serverInfo;
        if (r.status !== 200 || !info || !r.sid) { errors.push(url + ": HTTP " + r.status + (r.json?.error?.message ? " " + r.json.error.message : "")); continue; }
        await this.post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, r.sid).catch(() => null);
        this.session = { url, sid: r.sid, name: String(info.name ?? ""), version: String(info.version ?? "") };
        return this.session;
      } catch (e) { errors.push(url + ": " + String((e as Error).message ?? e)); }
    }
    throw Object.assign(new Error("连不上 Unity MCP（" + errors.join("；") + "）"), { code: "UPSTREAM_ERROR", status: 503 });
  }

  private async callOn(s: McpSession, name: string, args: unknown): Promise<{ isError: boolean; text: string; structured: any }> {
    const r = await this.post(s.url, { jsonrpc: "2.0", id: this.id++, method: "tools/call", params: { name, arguments: args ?? {} } }, s.sid);
    if (r.status !== 200) throw Object.assign(new Error("Unity MCP " + name + " HTTP " + r.status), { status: 502 });
    if (r.json?.error) {
      const msg = String(r.json.error.message ?? "MCP 调用失败");
      // 会话过期：让上层重连
      if (/session|initialized/i.test(msg)) throw Object.assign(new Error(msg), { code: "SESSION_LOST" });
      throw Object.assign(new Error(msg), { status: 502 });
    }
    const res = r.json?.result ?? {};
    const text = Array.isArray(res.content) ? res.content.map((c: any) => (c && typeof c.text === "string" ? c.text : "")).filter(Boolean).join("\n") : "";
    return { isError: res.isError === true, text, structured: res.structuredContent ?? null };
  }

  async call(name: string, args: unknown): Promise<{ isError: boolean; text: string; structured: any }> {
    const s = await this.connect();
    try { return await this.callOn(s, name, args); }
    catch (e) {
      if ((e as any)?.code !== "SESSION_LOST") throw e;
      const fresh = await this.connect(true);
      return await this.callOn(fresh, name, args);
    }
  }

  /** 在编辑器主线程跑一段 C#（方法体，可 return），返回它的返回值。 */
  async csharp(code: string): Promise<string> {
    const r = await this.call("execute_code", { action: "execute", code, safety_checks: true });
    const data = r.structured?.data;
    if (r.isError || r.structured?.success === false) {
      throw Object.assign(new Error(r.structured?.message ?? r.text ?? "Unity 执行 C# 失败"), { status: 502 });
    }
    if (data && typeof data === "object" && "result" in data) return String((data as any).result ?? "");
    return r.text;
  }
}

/** 读当前编辑器信息（工程路径/版本/是否在播放）。 */
export async function unityEditorInfo(u: UnityMcp): Promise<UnityEditorInfo> {
  const raw = await u.csharp(
    "var dp = Application.dataPath.Replace(System.IO.Path.DirectorySeparatorChar, '/');\n" +
    "var proj = dp.Substring(0, dp.Length - 6);\n" +
    "return dp + \"|\" + proj + \"|\" + Application.unityVersion + \"|\" + (EditorApplication.isPlaying ? \"1\" : \"0\") + \"|\" + (EditorApplication.isCompiling ? \"1\" : \"0\") + \"|\" + UnityEngine.SceneManagement.SceneManager.GetActiveScene().path;",
  );
  const [dataPath = "", projectPath = "", unityVersion = "", playing = "0", compiling = "0", scenePath = ""] = String(raw).split("|");
  return {
    endpoint: u.endpoint, serverName: u.serverName, dataPath, projectPath,
    projectName: baseName(projectPath), unityVersion,
    isPlaying: playing === "1", isCompiling: compiling === "1", scenePath,
  };
}

/** 列出条目里可以导入 Unity 的 .unitypackage（压缩包内的也算，含一层 zip 套 zip）。 */
export async function listUnityPackageCandidates(repo: Repo, itemId: number): Promise<UnityPackageCandidate[]> {
  const out: UnityPackageCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: UnityPackageCandidate) => { if (!seen.has(c.key)) { seen.add(c.key); out.push(c); } };

  for (const asset of repo.listAssets(itemId)) {
    if (asset.container === "unitypackage") {
      push({ key: asset.id + "|", label: baseName(asset.path), assetId: asset.id, container: asset.container, sourcePath: asset.path, entryPath: null, innerEntryPath: null, size: asset.size });
      continue;
    }
    if (asset.container !== "zip" && asset.container !== "7z" && asset.container !== "rar") continue;
    let entries = repo.getArchiveEntries(asset.id) as any[];
    if (!entries.length) {
      try {
        const listing = await listArchive(asset.path, { maxEntries: 20000 });
        repo.replaceArchiveEntries(asset.id, listing.entries.map((e) => ({ path: e.path, size: e.size, isDir: e.isDir, ext: (e.path.match(/\.[^./]+$/) ?? [""])[0].toLowerCase() })));
        entries = repo.getArchiveEntries(asset.id) as any[];
      } catch { continue; }
    }
    const pkgs = entries.filter((e) => !e.isDir && /\.unitypackage$/i.test(String(e.path)) && Number(e.size) > 1024)
      .sort((a, b) => Number(b.size) - Number(a.size));
    for (const e of pkgs) {
      push({
        key: asset.id + "|" + e.path, label: String(e.path).split("/").pop() ?? String(e.path), assetId: asset.id,
        container: asset.container, sourcePath: asset.path, entryPath: String(e.path), innerEntryPath: null, size: Number(e.size) || 0,
      });
    }
    if (pkgs.length) continue;
    // 压缩包里没有直接的 unitypackage：下钻一层 zip（和抽缩略图时的规则一致），最多 2 个
    const zips = entries.filter((e) => !e.isDir && /\.zip$/i.test(String(e.path)) && Number(e.size) > 4096 && Number(e.size) < 256 * 1024 * 1024)
      .sort((a, b) => Number(b.size) - Number(a.size)).slice(0, MAX_NESTED_ZIPS);
    for (const z of zips) {
      const tmp = join(tmpdir(), "av-unity-" + process.pid + "-" + Date.now() + "-" + basename(String(z.path)).replace(/[^\w.\-]+/g, "_"));
      try {
        writeFileSync(tmp, await readArchiveEntry(asset.path, String(z.path), MAX_PACKAGE_BYTES));
        const inner = await listArchive(tmp, { maxEntries: 5000 });
        for (const e of inner.entries.filter((x) => !x.isDir && /\.unitypackage$/i.test(x.path) && x.size > 1024).sort((a, b) => b.size - a.size).slice(0, 5)) {
          push({
            key: asset.id + "|" + z.path + "|" + e.path, label: e.path.split("/").pop() ?? e.path, assetId: asset.id,
            container: "zip", sourcePath: asset.path, entryPath: String(z.path), innerEntryPath: e.path, size: e.size,
            note: "压缩包内 " + basename(String(z.path)),
          });
        }
      } catch { /* 单个内层 zip 失败不影响 */ }
      finally { try { unlinkSync(tmp); } catch { /* ignore */ } }
    }
  }
  return out.sort((a, b) => b.size - a.size);
}

/** 把候选包"落地"成 Unity 能读到的磁盘路径（包本体直接用；压缩包内的解到 staging 目录）。 */
export async function stageUnityPackage(cand: UnityPackageCandidate, stagingDir: string): Promise<{ path: string; bytes: number }> {
  if (!cand.entryPath) {
    if (!existsSync(cand.sourcePath)) throw Object.assign(new Error("文件不存在：" + cand.sourcePath), { code: "NOT_FOUND", status: 404 });
    return { path: cand.sourcePath, bytes: statSync(cand.sourcePath).size };
  }
  const dir = join(stagingDir, String(cand.assetId));
  mkdirSync(dir, { recursive: true });
  const safe = String(cand.label).replace(/[^\w.\-\u4e00-\u9fff]+/g, "_") || "package.unitypackage";
  const dest = join(dir, safe);
  let outerBuf: Buffer;
  if (cand.innerEntryPath) {
    const tmp = join(tmpdir(), "av-unity-" + process.pid + "-" + Date.now() + "-inner.zip");
    writeFileSync(tmp, await readArchiveEntry(cand.sourcePath, cand.entryPath!, MAX_PACKAGE_BYTES));
    try { outerBuf = await readArchiveEntry(tmp, cand.innerEntryPath, MAX_PACKAGE_BYTES); }
    finally { try { unlinkSync(tmp); } catch { /* ignore */ } }
  } else {
    outerBuf = await readArchiveEntry(cand.sourcePath, cand.entryPath, MAX_PACKAGE_BYTES);
  }
  writeFileSync(dest, outerBuf);
  return { path: dest, bytes: outerBuf.length };
}

/** 真正导入：交给 Unity 的 AssetDatabase.ImportPackage(path, interactive:false)。 */
export async function importPackagesIntoUnity(u: UnityMcp, paths: string[]): Promise<{ queued: string[]; failed: string[]; raw: string }> {
  if (!paths.length) return { queued: [], failed: [], raw: "" };
  const literals = paths.map((p) => '@"' + toHostPath(p).replace(/"/g, '""') + '"').join(", ");
  const code =
    "var ps = new string[] { " + literals + " };\n" +
    "var lines = new System.Collections.Generic.List<string>();\n" +
    "foreach (var p in ps) {\n" +
    "  if (!System.IO.File.Exists(p)) { lines.Add(\"MISSING|\" + p); continue; }\n" +
    "  try { AssetDatabase.ImportPackage(p, false); lines.Add(\"QUEUED|\" + p + \"|\" + new System.IO.FileInfo(p).Length); }\n" +
    "  catch (System.Exception e) { lines.Add(\"ERROR|\" + p + \"|\" + e.Message.Replace(System.Environment.NewLine, \" \")); }\n" +
    "}\n" +
    "return string.Join(System.Environment.NewLine, lines.ToArray());";
  const raw = await u.csharp(code);
  const queued: string[] = []; const failed: string[] = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const [tag, ...rest] = line.split("|");
    if (tag === "QUEUED") queued.push(rest.join("|"));
    else if (tag === "ERROR" || tag === "MISSING") failed.push(rest.join("|"));
  }
  return { queued, failed, raw: String(raw) };
}

/** 读编辑器控制台（structuredContent.data 是字符串数组；退回解析 text 里的 JSON）。 */
export async function readUnityConsole(u: UnityMcp, types: string[] = ["error"], count = 20): Promise<string[]> {
  const clean = (arr: unknown[]) => arr.map((x) => String(x).replace(/\s+$/, "")).filter(Boolean).slice(0, count);
  try {
    const r = await u.call("read_console", { action: "get", types, count: String(count), format: "plain" });
    const d = (r.structured as any)?.data;
    if (Array.isArray(d)) return clean(d);
    if (typeof d === "string") return clean(d.split(/\r?\n/));
    const t = String(r.text ?? "").trim();
    if (t.startsWith("{")) {
      try {
        const j = JSON.parse(t);
        if (Array.isArray(j.data)) return clean(j.data);
        if (typeof j.data === "string") return clean(j.data.split(/\r?\n/));
      } catch { /* 不是 JSON 就当纯文本 */ }
    }
    return clean(t.split(/\r?\n/));
  } catch { return []; }
}

/** 导入前先清空控制台，这样导入后读到的 error 一定是这次导入产生的。 */
export async function clearUnityConsole(u: UnityMcp): Promise<boolean> {
  try { await u.call("read_console", { action: "clear" }); return true; } catch { return false; }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
