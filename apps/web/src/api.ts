/**
 * 统一 HTTP 层 —— 所有 fetch 只从这里发出（组件不得直接 fetch）。
 * 服务不可达时自动回退内置 mock（形状严格同 docs/api.md）。
 * 注意：/jobs 相关端点在 docs/api.md 未固定响应包裹形状，服务端实测返回裸 JobRow / {events}，
 *       故此处对所有列表/包裹响应做宽容归一化（裸数组、{key:[]}、{job} 三种都吃）。
 */
import type {
  AppErrorCode, ArchiveEntry, AssetRow, AvatarMatch, BoothItemMeta, ContainerKind, ItemStatus,
  JobEventRow, JobRow, LibraryRootRow, RootMode, SourceSite, TagRow, UnityPackageAsset,
} from "@core/contracts";
import { mockHandle, mockMediaUrl, mockEntry, MockHttpError } from "./mock";
import type {
  AssetDetailResponse, AssetTreeResponse, AvatarCard, AvatarsResponse, BoothPeekResponse, HealthResponse,
  ItemCardWeb, ItemDetailWeb, ItemQuery, ItemsResponse, JobIdResponse, JobsResponse, JobActionResponse,
  RootsResponse, ScanDryRunResponse, ScanPlanItem, StatsResponse, TagsResponse, UnityPackageResponse, ViewMode,
} from "./types";

export const API_BASE = "/api";

export class ApiError extends Error {
  constructor(public code: AppErrorCode, message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}

let mode: ViewMode = "live";
const listeners = new Set<(m: ViewMode) => void>();

export function apiMode(): ViewMode { return mode; }
export function onModeChange(cb: (m: ViewMode) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
function setMode(m: ViewMode): void {
  if (mode === m) return;
  mode = m;
  for (const cb of listeners) cb(m);
}

function queryString(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) { for (const x of v) sp.append(k, String(x)); continue; }
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? "?" + s : "";
}

// ---------- 形状归一化（容忍裸数组 / 包裹对象 / 缺字段） ----------
function arr<T>(x: unknown): T[] { return Array.isArray(x) ? (x as T[]) : []; }
function pickArray<T>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object") {
    const v = (raw as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v as T[];
  }
  return [];
}
function rec(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" ? (x as Record<string, unknown>) : {};
}
function numOr(x: unknown, dflt: number): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : dflt;
}

function timeoutSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, cancel: () => clearTimeout(t) };
}

/** 探测后端；不可达 → mock 模式（也可用 ?mock=1 强制）。 */
export async function initApi(): Promise<ViewMode> {
  const forced = typeof location !== "undefined" ? new URLSearchParams(location.search).get("mock") : null;
  if (forced === "1") { setMode("mock"); return mode; }
  const t = timeoutSignal(2500);
  try {
    const res = await fetch(API_BASE + "/health", { signal: t.signal });
    setMode(res.ok ? "live" : "mock");
  } catch {
    setMode("mock");
  } finally {
    t.cancel();
  }
  return mode;
}

interface MockResult { status: number; body: unknown }

function fromMock<T>(method: string, path: string, body?: unknown): T {
  const qi = path.indexOf("?");
  const p = qi < 0 ? path : path.slice(0, qi);
  const q = new URLSearchParams(qi < 0 ? "" : path.slice(qi + 1));
  const out: MockResult = mockHandle(method, p, q, body);
  if (out.status >= 400) {
    const err = rec(out.body).error as { code?: AppErrorCode; message?: string } | undefined;
    throw new ApiError(err?.code ?? "INVALID_INPUT", err?.message ?? "mock 请求失败", out.status);
  }
  return out.body as T;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (mode === "mock") return fromMock<T>(method, path, body);
  const t = timeoutSignal(20000);
  try {
    const res = await fetch(API_BASE + path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: t.signal,
    });
    if (!res.ok) {
      let code: AppErrorCode = "INVALID_INPUT";
      let message = method + " " + path + " → HTTP " + res.status;
      try {
        const j = rec(await res.json());
        const e = rec(j.error);
        if (typeof e.code === "string") code = e.code as AppErrorCode;
        if (typeof e.message === "string") message = e.message;
      } catch { /* 非 JSON 错误体，保留默认文案 */ }
      throw new ApiError(code, message, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e instanceof MockHttpError) throw new ApiError(e.code, e.message, e.status);
    // 网络层失败（服务未起/被中断）→ 回退 mock，UI 会订阅到模式变化并重载
    setMode("mock");
    return fromMock<T>(method, path, body);
  } finally {
    t.cancel();
  }
}

/** 可读错误文案（含 409 状态机提示）。 */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "INVALID_TRANSITION") return "状态机拒绝（409 INVALID_TRANSITION）：" + e.message;
    if (e.code === "CONFLICT") return "冲突（409 CONFLICT）：" + e.message;
    if (e.code === "LOGIN_REQUIRED") return "需要 BOOTH 登录（401 LOGIN_REQUIRED）：" + e.message;
    if (e.code === "UPSTREAM_ERROR") return "上游错误（502 UPSTREAM_ERROR）：" + e.message;
    if (e.code === "NOT_FOUND") return "未找到（404）：" + e.message;
    return e.code + "：" + e.message;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

/** 图片 URL：mock 模式返回内联 data URL，live 模式走 /media/:id。 */
export function mediaUrl(imageId: number, w = 480): string {
  if (mode === "mock") return mockMediaUrl(imageId, w);
  return API_BASE + "/media/" + imageId + "?w=" + w;
}

// ---------------- 条目 ----------------
export async function getHealth(): Promise<HealthResponse> {
  const raw = await request<Partial<HealthResponse>>("GET", "/health");
  const r = rec(raw);
  return {
    ok: r.ok !== false,
    version: typeof r.version === "string" ? r.version : "?",
    dbPath: typeof r.dbPath === "string" ? r.dbPath : "",
    roots: pickArray<LibraryRootRow>(raw, "roots"),
    counts: (r.counts && typeof r.counts === "object" ? r.counts : {}) as Record<string, number>,
  };
}

export async function listItems(q: ItemQuery): Promise<ItemsResponse> {
  const raw = await request<unknown>("GET", "/items" + queryString({
    q: q.q, avatar: q.avatar, avatarMatch: q.avatarMatch, ownedOnly: q.ownedOnly ? 1 : undefined,
    site: q.site, status: q.status, tag: q.tag, container: q.container, imported: q.imported,
    sort: q.sort, limit: q.limit, offset: q.offset,
  }));
  const items = pickArray<ItemCardWeb>(raw, "items");
  const total = numOr(rec(raw).total, items.length);
  return { total, items };
}

export async function getItem(id: number): Promise<ItemDetailWeb> {
  const raw = await request<ItemDetailWeb>("GET", "/items/" + id);
  return {
    ...(raw as ItemDetailWeb),
    images: arr(raw?.images),
    assets: arr(raw?.assets),
    avatars: arr(raw?.avatars),
    tags: arr(raw?.tags),
  };
}
export function createItem(title: string, sourceUrl?: string, notes?: string): Promise<ItemCardWeb> {
  return request("POST", "/items", { title, sourceUrl, notes });
}
export function patchItem(id: number, patch: Record<string, unknown>): Promise<ItemCardWeb> {
  return request("PATCH", "/items/" + id, patch);
}
export function deleteItem(id: number): Promise<unknown> { return request("DELETE", "/items/" + id); }
export function restoreItem(id: number): Promise<ItemCardWeb> { return request("POST", "/items/" + id + "/restore"); }
export function addImages(id: number, body: { paths?: string[]; url?: string; role?: string; origin?: string }): Promise<unknown> {
  return request("POST", "/items/" + id + "/images", body);
}
export function deleteImage(id: number, imageId: number): Promise<unknown> { return request("DELETE", "/items/" + id + "/images/" + imageId); }
export function setCover(id: number, imageId: number): Promise<unknown> { return request("POST", "/items/" + id + "/images/" + imageId + "/cover"); }
export function addAsset(id: number, path: string): Promise<AssetRow> { return request("POST", "/items/" + id + "/assets", { path }); }
/** 套装/合集 */
export function getCollections(): Promise<{ collections: { id: number; name: string; itemCount: number }[] }> { return request("GET", "/collections"); }
export function createCollection(name: string, itemIds?: number[]): Promise<{ id: number; name: string; itemCount: number }> { return request("POST", "/collections", { name, itemIds }); }
export function addToCollection(id: number, itemIds: number[]): Promise<unknown> { return request("POST", "/collections/" + id + "/items", { itemIds }); }
export function removeFromCollection(id: number, itemId: number): Promise<unknown> { return request("DELETE", "/collections/" + id + "/items/" + itemId); }
/** 合并条目：把 source 的压缩包/图片/模型/标签/历史并到 target，source 进回收站 */
export function mergeItems(sourceId: number, targetId: number): Promise<unknown> { return request("POST", "/items/merge", { sourceId, targetId }); }
/** 把已有（扫库建出来的）本地条目关联到 BOOTH 商品：补元数据 + 抓图集。merge=true 时合并到已存在的同商品条目。 */
export function linkBooth(id: number, url: string, merge = false): Promise<unknown> {
  return request("POST", "/items/" + id + "/link-booth", { url, merge });
}
/** 追加标签（api.md v1.1：POST /items/:id/tags {tags}）→ ItemDetail */
export function addItemTags(id: number, tags: string[]): Promise<unknown> { return request("POST", "/items/" + id + "/tags", { tags }); }
/** 删除单个标签（api.md v1.1：DELETE /items/:id/tags/:tagId）→ ItemDetail */
export function removeItemTag(id: number, tagId: number | string): Promise<unknown> { return request("DELETE", "/items/" + id + "/tags/" + encodeURIComponent(String(tagId))); }
/** 缩略图重排（api.md v1.1：POST /items/:id/images/reorder {imageIds}）→ ItemDetail */
export function reorderImages(id: number, imageIds: number[]): Promise<unknown> { return request("POST", "/items/" + id + "/images/reorder", { imageIds }); }
export function addItemAvatars(id: number, avatarIds: number[], match: AvatarMatch): Promise<unknown> {
  return request("POST", "/items/" + id + "/avatars", { avatarIds, match });
}
export function removeItemAvatar(id: number, avatarId: number): Promise<unknown> { return request("DELETE", "/items/" + id + "/avatars/" + avatarId); }

function jobIdResponse(raw: unknown): JobIdResponse {
  const r = rec(raw);
  const out: JobIdResponse = { jobId: numOr(r.jobId, 0) };
  if (r.itemId !== undefined && r.itemId !== null) out.itemId = numOr(r.itemId, 0);
  return out;
}
export async function checkUpdate(id: number): Promise<JobIdResponse> {
  return jobIdResponse(await request<unknown>("POST", "/items/" + id + "/check-update"));
}
export async function matchAvatars(id: number): Promise<JobIdResponse> {
  return jobIdResponse(await request<unknown>("POST", "/items/" + id + "/match-avatars"));
}

// ---------------- 头像 ----------------
export async function listAvatars(q?: { q?: string; ownedOnly?: boolean }): Promise<AvatarsResponse> {
  const raw = await request<unknown>("GET", "/avatars" + queryString({ q: q?.q, ownedOnly: q?.ownedOnly ? 1 : undefined }));
  return { avatars: pickArray<AvatarCard>(raw, "avatars") };
}
export async function getAvatarItems(id: number, q?: ItemQuery): Promise<ItemsResponse> {
  const raw = await request<unknown>("GET", "/avatars/" + id + queryString({ q: q?.q, ownedOnly: q?.ownedOnly ? 1 : undefined, limit: q?.limit }));
  const items = pickArray<ItemCardWeb>(raw, "items");
  return { total: numOr(rec(raw).total, items.length), items };
}
export function createAvatar(body: { name: string; aliases?: string[]; kind?: string; owned?: boolean; boothItemId?: string }): Promise<AvatarCard> {
  return request("POST", "/avatars", body);
}
export function patchAvatar(id: number, patch: Record<string, unknown>): Promise<AvatarCard> { return request("PATCH", "/avatars/" + id, patch); }
export function addAlias(id: number, alias: string, lang?: string, source?: string): Promise<unknown> {
  return request("POST", "/avatars/" + id + "/aliases", { alias, lang, source });
}
export function removeAlias(id: number, aliasId: number): Promise<unknown> { return request("DELETE", "/avatars/" + id + "/aliases/" + aliasId); }

// ---------------- 资产 ----------------
export async function getAsset(id: number): Promise<AssetDetailResponse> {
  const raw = await request<AssetDetailResponse>("GET", "/assets/" + id);
  return { ...(raw as AssetDetailResponse), avatars: arr(raw?.avatars) };
}
export async function getAssetTree(id: number): Promise<AssetTreeResponse> {
  const raw = await request<AssetTreeResponse>("GET", "/assets/" + id + "/tree");
  return { ...(raw as AssetTreeResponse), entries: arr<ArchiveEntry>(raw?.entries) };
}
export async function getUnityPackage(id: number): Promise<UnityPackageResponse> {
  const raw = await request<UnityPackageResponse>("GET", "/assets/" + id + "/unitypackage");
  const assets = arr<UnityPackageAsset>(raw?.assets);
  const byTypeRaw = rec(raw).byType;
  const byType = byTypeRaw && typeof byTypeRaw === "object" && !Array.isArray(byTypeRaw)
    ? (byTypeRaw as Record<string, number>)
    : undefined;
  return { ...(raw as UnityPackageResponse), assets, total: numOr(rec(raw).total, assets.length), byType };
}
export async function reindexAsset(id: number): Promise<JobIdResponse> {
  return jobIdResponse(await request<unknown>("POST", "/assets/" + id + "/reindex"));
}

export interface EntryPreview { contentType: string; url: string | null; text: string | null }

/** 从压缩包内直读单文件（图片 → objectURL；文本 → 前 64KB 文本）。 */
export async function readEntry(assetId: number, path: string): Promise<EntryPreview> {
  const q = "?path=" + encodeURIComponent(path);
  if (mode === "mock") {
    const r = mockEntry(assetId, path);
    return { contentType: r.contentType, url: r.dataUrl, text: r.text };
  }
  const t = timeoutSignal(20000);
  try {
    const res = await fetch(API_BASE + "/assets/" + assetId + "/entry" + q, { signal: t.signal });
    if (!res.ok) {
      let message = "读取包内文件失败：HTTP " + res.status;
      try {
        const j = rec(await res.json());
        const m = rec(j.error).message;
        if (typeof m === "string") message = m;
      } catch { /* ignore */ }
      throw new ApiError("NOT_FOUND", message, res.status);
    }
    const ct = res.headers.get("content-type") ?? "application/octet-stream";
    if (ct.startsWith("image/")) {
      const blob = await res.blob();
      return { contentType: ct, url: URL.createObjectURL(blob), text: null };
    }
    const buf = await res.arrayBuffer();
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, 65536));
    return { contentType: ct, url: null, text };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const r = mockEntry(assetId, path);
    return { contentType: r.contentType, url: r.dataUrl, text: r.text };
  } finally {
    t.cancel();
  }
}

// ---------------- 导入 / 扫描 ----------------
export async function boothPeek(url: string): Promise<BoothPeekResponse> {
  const raw = await request<BoothPeekResponse>("GET", "/booth/peek" + queryString({ url }));
  const r = rec(raw);
  return { ...(raw as BoothPeekResponse), images: arr(r.images), tags: arr(r.tags), variations: arr(r.variations) };
}
export async function importUrl(url: string, downloadImages = true): Promise<JobIdResponse> {
  return jobIdResponse(await request<unknown>("POST", "/import/url", { url, downloadImages }));
}
export async function importPaths(paths: string[]): Promise<JobIdResponse> {
  return jobIdResponse(await request<unknown>("POST", "/import/paths", { paths }));
}
export async function scan(body: { rootId?: number; path?: string; deep?: boolean }): Promise<JobIdResponse> {
  return jobIdResponse(await request<unknown>("POST", "/scan", body));
}
/** POST /scan {dryRun:true} —— 只读预览待入库条目（服务端实测支持；api.md 未列，故单独入口） */
export async function scanDryRun(body: { rootId?: number; path?: string; deep?: boolean }): Promise<ScanDryRunResponse> {
  const raw = await request<unknown>("POST", "/scan", { ...body, dryRun: true });
  return { items: pickArray<ScanPlanItem>(raw, "items") };
}

// ---------------- 作业 ----------------
export async function listJobs(state?: string, limit = 50): Promise<JobsResponse> {
  const raw = await request<unknown>("GET", "/jobs" + queryString({ state, limit }));
  return { jobs: pickArray<JobRow>(raw, "jobs") };
}
export async function jobEvents(id: number): Promise<JobEventRow[]> {
  return pickArray<JobEventRow>(await request<unknown>("GET", "/jobs/" + id + "/events"), "events");
}
/** 服务端实测返回裸 JobRow；mock 返回 {job}。两种都归一化为 {job}。 */
export async function jobAction(id: number, action: "pause" | "resume" | "cancel" | "retry" | "abandon"): Promise<JobActionResponse> {
  const raw = await request<unknown>("POST", "/jobs/" + id + "/" + action);
  const r = rec(raw);
  const job = (r.job && typeof r.job === "object" ? r.job : raw) as JobRow;
  return { job };
}

// ---------------- 工程 ----------------
export interface ProjectRow { id: number; name: string; path: string; created_at: string }
export async function listProjects(): Promise<{ projects: ProjectRow[] }> {
  return { projects: pickArray<ProjectRow>(await request<unknown>("GET", "/projects"), "projects") };
}
export function recordImport(projectId: number, itemId: number, assetId?: number): Promise<unknown> {
  return request("POST", "/projects/" + projectId + "/imports", { itemId, assetId });
}

// ---------------- 其它 ----------------
export async function listRoots(): Promise<RootsResponse> {
  return { roots: pickArray<LibraryRootRow>(await request<unknown>("GET", "/roots"), "roots") };
}
export async function listTags(): Promise<TagsResponse> {
  return { tags: pickArray<TagRow>(await request<unknown>("GET", "/tags"), "tags") };
}
export function getStats(): Promise<StatsResponse> { return request("GET", "/stats"); }

export type { ArchiveEntry, AssetRow, BoothItemMeta, ContainerKind, ItemStatus, JobRow, LibraryRootRow, RootMode, SourceSite, TagRow };