/**
 * Unity 编辑器桥：经 mcp-for-unity（Streamable HTTP，默认 127.0.0.1:8080/mcp）
 * 在**用户当前打开的那个 Unity 编辑器**里跑 C#，把素材包真正导入工程（不是只登记一行）。
 *
 * 为什么这里自己实现 MCP 客户端：MCP 是给 agent 的协议，本服务是 app 自己当客户端，
 * 只需要三件事——initialize → notifications/initialized → tools/call。
 * 端点优先取 settings.unity_mcp_url，缺省按 UNITY_MCP_URLS 逐个探测。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { listArchive, readArchiveEntry } from "../../../../packages/core/src/archive/list";
import { listUnityPackage } from "../../../../packages/core/src/unitypackage";
import { normKey } from "../../../../packages/core/src/contracts";
import type { Repo } from "../db/repo";

/** 本机两个已知的 Unity 桥（都只监听 127.0.0.1）。 */
export const UNITY_MCP_URLS = ["http://127.0.0.1:8080/mcp", "http://127.0.0.1:14523/mcp"];
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
/** 内层 zip 下钻上限：VRChat 素材常见"一个 7z 里 9 个 per-avatar zip"，所以放得比较宽。 */
const MAX_NESTED_ZIPS = 16;
const NESTED_ZIP_MAX_BYTES = 512 * 1024 * 1024;
const NESTED_CACHE_MAX = 64;

/** 取文件名：本服务可能在 WSL 里跑而路径是 Windows 形式，path.basename 在 POSIX 下不认反斜杠。 */
export const baseName = (p: string): string => String(p).split(/[\\/]/).filter(Boolean).pop() ?? String(p);

export interface UnityEditorInfo {
  endpoint: string; serverName: string; dataPath: string; projectPath: string; projectName: string;
  unityVersion: string; isPlaying: boolean; isCompiling: boolean; scenePath: string;
}

/** 从包名/内层 zip 名/工程路径里认出来的 avatar（用于"按当前工程自动匹配"）。 */
export interface UnityAvatarHint { id: number; name: string; via: string }
export interface AvatarLite { id: number; name: string; aliases?: string[] }

export interface UnityPackageCandidate {
  /** 稳定 key：assetId + 包内路径，前端勾选后回传 */
  key: string; label: string; assetId: number; container: string;
  sourcePath: string; entryPath: string | null; innerEntryPath: string | null;
  size: number; note?: string;
  /** 这个包是给哪个 avatar 的（认不出来就是 null） */
  avatar?: UnityAvatarHint | null;
  /** 是否匹配"当前打开的那个工程"的 avatar */
  matched?: boolean;
}

/** 按分隔符切词（保留中日文）后再 normKey —— 整词比对，避免 "moe" 命中 "moefication"。 */
export function tokenize(text: string): string[] {
  return String(text ?? "")
    .split(/[^0-9A-Za-z\u3040-\u30ff\u4e00-\u9fff]+/)
    .map((t) => normKey(t))
    .filter(Boolean);
}

/** 在一段文本（包名、内层 zip 名、工程路径）里找 avatar：整词命中名字或别名，取最长命中。 */
export function matchAvatarByText(avatars: AvatarLite[], text: string): UnityAvatarHint | null {
  const tokens = new Set(tokenize(text));
  if (!tokens.size) return null;
  let best: UnityAvatarHint | null = null;
  let bestLen = 0;
  for (const a of avatars) {
    for (const raw of [a.name, ...(a.aliases ?? [])]) {
      const k = normKey(String(raw ?? ""));
      if (k.length < 3 || k.length <= bestLen) continue; // <3 字符的别名太容易误判（in/ri/…）
      if (!tokens.has(k)) continue;
      best = { id: a.id, name: a.name, via: String(raw) };
      bestLen = k.length;
    }
  }
  return best;
}

/** 内层 zip 扫描结果缓存（key = assetId:size:mtime），抽屉反复打开不用重扫。 */
const nestedCache = new Map<string, UnityPackageCandidate[]>();

export interface UnityPackageScan {
  packages: UnityPackageCandidate[];
  /** 有几个内层 zip 没读成功（网络盘/9p 偶发失败；>0 时结果不进缓存，点「重新检测」会重扫） */
  scanErrors: number;
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

/** 诊断日志出口（routes 注册时接上；单测/脚本下静默）。 */
let optsLog: (m: string) => void = () => {};
export function setUnityLogger(fn: (m: string) => void): void { optsLog = fn; }

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

/** 归档资产里所有 .unitypackage 的 assetPath（按内容匹配 avatar 用）；带内存缓存。 */
const pkgPathsCache = new Map<string, string[]>();
export async function unityPackagePathsOf(repo: Repo, asset: { id: number; item_id: number; container: string; size: number; mtime?: string | null }): Promise<string[]> {
  if (asset.container === "unitypackage") return (repo.getUnityPackageAssets(asset.id) as any[]).map((a) => String(a.assetPath));
  if (asset.container !== "zip" && asset.container !== "7z" && asset.container !== "rar") return [];
  const key = asset.id + ":" + asset.size + ":" + String(asset.mtime ?? "");
  const hit = pkgPathsCache.get(key);
  if (hit) return hit;
  const out: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "av-match-"));
  try {
    const cands = (await listUnityPackageCandidates(repo, asset.item_id)).packages.filter((c) => c.assetId === asset.id).slice(0, 6);
    for (const c of cands) {
      try {
        const staged = await stageUnityPackage(c, dir);
        const listing = await listUnityPackage(staged.path, { maxAssets: 20000 });
        for (const x of listing.assets) out.push(String(x.assetPath));
      } catch { /* 单个内层包失败不影响 */ }
    }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  // 空结果不缓存：偶发读失败不该让这个资产永远认不出内容
  if (out.length) {
    pkgPathsCache.set(key, out);
    if (pkgPathsCache.size > 64) { const oldest = pkgPathsCache.keys().next().value; if (oldest) pkgPathsCache.delete(oldest); }
  }
  return out;
}

/** 列出条目里可以导入 Unity 的 .unitypackage（压缩包内的、zip 套 zip 的也算），并按"是不是当前工程的 avatar"排前。 */
export async function listUnityPackageCandidates(
  repo: Repo,
  itemId: number,
  opts: { avatars?: AvatarLite[]; projectAvatarId?: number | null; refresh?: boolean } = {},
): Promise<UnityPackageScan> {
  let scanErrors = 0;
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
    // 压缩包里没有直接的 unitypackage：把内层 zip 全部下钻（实测 VRChat 素材常见"一个包里 N 个 per-avatar zip"）。
    const zips = entries
      .filter((e) => !e.isDir && /\.zip$/i.test(String(e.path)) && Number(e.size) > 4096 && Number(e.size) < NESTED_ZIP_MAX_BYTES)
      .sort((a, b) => Number(b.size) - Number(a.size)).slice(0, MAX_NESTED_ZIPS);
    if (!zips.length) continue;

    const cacheKey = asset.id + ":" + asset.size + ":" + String(asset.mtime ?? "");
    let nested = opts.refresh ? undefined : nestedCache.get(cacheKey);
    if (!nested) {
      nested = [];
      let failed = 0;
      const tmpDir = mkdtempSync(join(tmpdir(), "av-unity-nested-"));
      try {
        for (let i = 0; i < zips.length; i++) {
          const z = zips[i]!;
          const tmp = join(tmpDir, i + "-" + (baseName(String(z.path)).replace(/[^\w.\-]+/g, "_") || "inner.zip"));
          try {
            writeFileSync(tmp, await readArchiveEntry(asset.path, String(z.path), MAX_PACKAGE_BYTES));
            const inner = await listArchive(tmp, { maxEntries: 5000 });
            for (const e of inner.entries.filter((x) => !x.isDir && /\.unitypackage$/i.test(x.path) && x.size > 1024).sort((a, b) => b.size - a.size).slice(0, 8)) {
              // 注意：这里必须进 nested（缓存的是它），进 out 会让缓存永远是空数组
              nested.push({
                key: asset.id + "|" + z.path + "|" + e.path, label: e.path.split("/").pop() ?? e.path, assetId: asset.id,
                container: "zip", sourcePath: asset.path, entryPath: String(z.path), innerEntryPath: e.path, size: e.size,
                note: baseName(String(z.path)),
              });
            }
          } catch { failed++; optsLog("内层 zip 读取失败（不影响其他的）：" + z.path); }
        }
      } finally { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
      // 有读失败的就不写缓存：网络盘/9p 偶发失败不能把"空结果"钉死在内存里（否则要重启才恢复）。
      if (failed === 0) {
        nestedCache.set(cacheKey, nested);
        if (nestedCache.size > NESTED_CACHE_MAX) { const oldest = nestedCache.keys().next().value; if (oldest) nestedCache.delete(oldest); }
      } else { scanErrors += failed; }
    }
    for (const c of nested) push({ ...c });
  }
  // 认 avatar：包名 + 内层 zip 名 + 包内路径都要看（很多素材把 avatar 名放在目录上）
  const avatars = opts.avatars ?? [];
  for (const c of out) {
    c.avatar = avatars.length ? matchAvatarByText(avatars, [c.label, c.note ?? "", c.entryPath ?? "", c.innerEntryPath ?? ""].join(" ")) : null;
    c.matched = !!(opts.projectAvatarId && c.avatar && c.avatar.id === opts.projectAvatarId);
  }
  // 匹配当前工程的排前面，其余按大小
  out.sort((a, b) => (Number(!!b.matched) - Number(!!a.matched)) || (b.size - a.size));
  return { packages: out, scanErrors };
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
