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
  AssetDetailResponse, AssetTreeResponse, AvatarCard, AvatarsResponse, BatchCategoryResponse, BoothPeekResponse,
  CategoriesResponse, CategoryConfig, CategoryCounts, CategoryImpact, CategoryNode, CategoryStatCount,
  DuplicateDiff, DuplicateFileDiff, DuplicateGroup, DuplicateGroupItem, DuplicateGroupsResponse,
  DuplicateLevel, DuplicateMatch, HealthResponse,
  ItemCardWeb, ItemDetailWeb, ItemDuplicatesResponse, ItemQuery, ItemsResponse, ItemRelatedResponse, ItemUsageResponse, JobIdResponse, JobsResponse, JobActionResponse,
  ReclassifyResponse, RecomputeResponse, RelatedLevel, RelatedMatch, ScanUsageResponse,
  RootsResponse, ScanDryRunResponse, ScanPlanItem, ScanPreview, ScanPreviewCounts, ScanPreviewItem, StatsResponse, TagListRow, TagsResponse, UnityPackageResponse,
  UpdateCheckResponse, ViewMode,
} from "./types";
export type { CategoriesResponse, CategoryConfig, CategoryNode, BatchCategoryResponse, ReclassifyResponse, ScanPreview, ScanPreviewCounts, ScanPreviewItem } from "./types";

// ---------- 扫描变更中心（M1）----------
export async function listScanPreviews(limit = 30) { return request<{ previews: ScanPreview[] }>("GET", "/scan/previews?limit=" + limit); }
export async function createScanPreview(input: { rootId?: number | null; path?: string; deep?: boolean }) {
  return request<{ previewId: number; state: string; jobId?: number; existing?: boolean }>("POST", "/scan/previews", input, { timeoutMs: 30000 });
}
export async function getScanPreview(id: number) {
  return request<{ preview: ScanPreview; applies: any[]; errors: any[] }>("GET", "/scan/previews/" + id);
}
export async function listScanPreviewItems(id: number, opts: { cursor?: number | null; limit?: number; change?: string } = {}) {
  const q = "?limit=" + (opts.limit ?? 100) + (opts.cursor ? "&cursor=" + opts.cursor : "") + (opts.change ? "&change=" + encodeURIComponent(opts.change) : "");
  return request<{ previewId: number; state: string; items: ScanPreviewItem[]; nextCursor: number | null; counts: ScanPreviewCounts; itemCounts: ScanPreview["itemCounts"] }>("GET", "/scan/previews/" + id + "/items" + q);
}
export async function decideScanPreviewItems(id: number, body: { keys?: string[]; change?: string; decision: "accept" | "skip" | "pending" }) {
  return request<{ updated: number; itemCounts: ScanPreview["itemCounts"] }>("POST", "/scan/previews/" + id + "/items", body);
}
export async function applyScanPreview(id: number, body: { planHash?: string | null; mode?: "all"; itemKeys?: string[]; idempotencyKey?: string }) {
  return request<{ previewId: number; applyRunId: number; jobId: number; files: number; missing: number; stale: number; requested: number }>("POST", "/scan/previews/" + id + "/apply", body, { timeoutMs: 30000 });
}
export async function cancelScanPreview(id: number) { return request<{ preview: ScanPreview }>("POST", "/scan/previews/" + id + "/cancel"); }
export async function retryScanPreview(id: number) { return request<{ jobId: number; files: number; missing: number; stale: number; retried: number }>("POST", "/scan/previews/" + id + "/retry", {}, { timeoutMs: 30000 }); }
export async function deleteScanPreview(id: number) { return request<{ deleted: boolean }>("DELETE", "/scan/previews/" + id); }

export const API_BASE = "/api";

export class ApiError extends Error {
  constructor(public code: AppErrorCode, message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}

let mode: ViewMode = "live";
let forcedMock = false;                       // ?mock=1：用户自己要 mock，别去自愈
let retryTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(m: ViewMode) => void>();

export function apiMode(): ViewMode { return mode; }
export function onModeChange(cb: (m: ViewMode) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
function setMode(m: ViewMode): void {
  // mock 只在启动探测失败 / 网络层报错时进入；进去不等于判死刑 —— 起一个自愈循环往回连。
  if (m === "mock") startRetryLoop(); else stopRetryLoop();
  if (mode === m) return;
  mode = m;
  for (const cb of listeners) cb(m);
}

/** 探一次后端是否活着（不抛错）。 */
async function probeHealth(timeoutMs = 2500): Promise<boolean> {
  const t = timeoutSignal(timeoutMs);
  try { const res = await fetch(API_BASE + "/health", { signal: t.signal }); return res.ok; }
  catch { return false; }
  finally { t.cancel(); }
}

/**
 * mock 模式自愈：每 4 秒 + 窗口重新获得焦点/可见时探一次 /health，后端一回来立刻切回 live。
 * 没有这个的话，只要有一次请求失败（比如后端正在重启、或某个长请求超时），
 * 整个界面就**永久**停在内置 mock 数据上，只能手动刷新页面 —— 实测踩过（"卡住了"）。
 */
function startRetryLoop(): void {
  if (retryTimer !== null || forcedMock || typeof window === "undefined") return;
  const tick = (): void => { void (async () => { if (mode === "mock" && await probeHealth()) setMode("live"); })(); };
  retryTimer = setInterval(tick, 4000);
  window.addEventListener("focus", tick);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
}
function stopRetryLoop(): void {
  if (retryTimer !== null) { clearInterval(retryTimer); retryTimer = null; }
}
/** 手动「重试连接」按钮用。 */
export async function retryConnect(): Promise<ViewMode> {
  if (await probeHealth()) setMode("live");
  return mode;
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
  if (forced === "1") { forcedMock = true; setMode("mock"); return mode; }
  setMode((await probeHealth(2500)) ? "live" : "mock");
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

async function request<T>(method: string, path: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
  if (mode === "mock") return fromMock<T>(method, path, body);
  const t = timeoutSignal(opts.timeoutMs ?? 20000);
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
    // 网络层失败 —— 但先确认后端是不是真的死了。
    // 反例（实测踩过）：某个请求自己超时（大压缩包列目录、BOOTH 抓取、Unity 桥探测都可能是慢的），
    // 旧逻辑会当场把整个界面切成内置 mock 数据（"10 条目 / 9 资产"），而且再也切不回来 —— 看起来就是"卡住了"。
    if (await probeHealth(1500)) {
      const aborted = (e as Error)?.name === "AbortError";
      throw new ApiError("UPSTREAM_ERROR", aborted
        ? "这次请求超时了（后端还在，只是太慢；可重试或先缩小范围）"
        : "请求失败：" + String((e as Error)?.message ?? e), 504);
    }
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

/**
 * 与 /api/items 同名的筛选参数（**不含分类条件**：计数口径要求分类本身不参与过滤）。
 * GET /api/categories/counts 与 GET /api/items 共用这一份，避免两边参数走偏。
 */
function itemFilterParams(q: ItemQuery): Record<string, unknown> {
  return {
    q: q.q, avatar: q.avatar, avatarMatch: q.avatarMatch, ownedOnly: q.ownedOnly ? 1 : undefined,
    site: q.site, status: q.status, tag: q.tag, container: q.container, imported: q.imported,
    // 标签多选（docs/categories-v3.md §4）：tags=a,b + tagsMatch=any|all；旧单值 tag 保持原样
    tags: q.tags && q.tags.length ? q.tags.join(",") : undefined,
    tagsMatch: q.tagsMatch && q.tagsMatch !== "any" ? q.tagsMatch : undefined,
    favoriteOnly: q.favoriteOnly ? 1 : undefined,
  };
}

export async function listItems(q: ItemQuery): Promise<ItemsResponse> {
  const raw = await request<unknown>("GET", "/items" + queryString({
    ...itemFilterParams(q),
    // 契约写法是 catIds=clothing,clothing.tops（服务端按 avatar 的方式 String(x).split(",")，逗号串两种实现都吃）
    catIds: q.categoryIds && q.categoryIds.length ? q.categoryIds.join(",") : undefined,
    catMatch: q.categoryMatch && q.categoryMatch !== "any" ? q.categoryMatch : undefined,
    uncategorized: q.uncategorized ? 1 : undefined,
    pendingCategory: q.pendingCategory ? 1 : undefined,
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

// ---------------- 物品分类（docs/categories.md §4） ----------------
/**
 * 后端没有分类接口时的显式判据（404 / 405 / 501 / NOT_FOUND）。
 * 需求 §4：**不得**静默 catch 成"点了没反应"——UI 必须能区分「未加载 / 后端不支持 / 失败」。
 */
export function isCategoryApiMissing(e: unknown): boolean {
  if (e instanceof ApiError) {
    return e.status === 404 || e.status === 405 || e.status === 501 || e.code === "NOT_FOUND";
  }
  // mock 模式下 request() 会把 MockHttpError 原样抛出（不经过 ApiError），这里按形状兜一层
  const err = e as { status?: unknown; code?: unknown } | null;
  if (err && typeof err === "object") {
    const st = typeof err.status === "number" ? err.status : 0;
    return st === 404 || st === 405 || st === 501 || err.code === "NOT_FOUND";
  }
  return false;
}
/** 分类相关请求的可读错误（404 时明确说「后端未提供分类接口」）。 */
export function categoryApiMessage(e: unknown, action = "分类操作"): string {
  if (isCategoryApiMissing(e)) return action + "失败：后端未提供分类接口（" + describeError(e) + "）";
  return action + "失败：" + describeError(e);
}

const num01 = (v: unknown, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

/** GET /api/categories → { categories 树(含 itemCount), stats, config }。 */
export async function getCategories(): Promise<CategoriesResponse> {
  const raw = rec(await request<unknown>("GET", "/categories"));
  const stats = rec(raw.stats);
  const config = rec(raw.config);
  return {
    categories: pickArray<CategoryNode>(raw, "categories"),
    stats: {
      counts: pickArray<CategoryStatCount>(stats, "counts"),
      uncategorized: numOr(stats.uncategorized, 0),
      pending: numOr(stats.pending, 0),
      total: numOr(stats.total, 0),
      missingFiles: numOr(stats.missingFiles, 0),
    },
    config: {
      autoThreshold: num01(config.autoThreshold, 0.75),
      suggestThreshold: num01(config.suggestThreshold, 0.4),
    } as CategoryConfig,
  };
}

/** 数字映射表归一化：服务端给 { id: count }，容忍数组形状 [{id,count}] 与缺字段。 */
function countMap(x: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (Array.isArray(x)) {
    for (const e of x) {
      const r = rec(e);
      const id = typeof r.id === "string" ? r.id : "";
      if (id) out[id] = numOr(r.count, 0);
    }
    return out;
  }
  const r = rec(x);
  for (const [k, v] of Object.entries(r)) out[k] = numOr(v, 0);
  return out;
}

/**
 * GET /api/categories/counts?<与 /api/items 相同的筛选参数> → { all, uncategorized, tops, subs }
 * 一级分类栏显示的就是这份**当前筛选下**的计数（随关键词/标签/头像/来源/状态/容器/已导入/收藏变化）。
 */
export async function getCategoryCounts(q: ItemQuery = {}): Promise<CategoryCounts> {
  const raw = rec(await request<unknown>("GET", "/categories/counts" + queryString(itemFilterParams(q))));
  return {
    all: numOr(raw.all, 0),
    uncategorized: numOr(raw.uncategorized, 0),
    tops: countMap(raw.tops),
    subs: countMap(raw.subs),
  };
}

/** GET /api/categories/:id/impact → 删除/合并前的影响面（UI 二次确认要显示的数字）。 */
export async function getCategoryImpact(id: string): Promise<CategoryImpact> {
  const raw = rec(await request<unknown>("GET", "/categories/" + encodeURIComponent(id) + "/impact"));
  return {
    items: numOr(raw.items, 0),
    direct: raw.direct === undefined ? undefined : numOr(raw.direct, 0),
    subs: numOr(raw.subs, 0),
    suggestions: numOr(raw.suggestions, 0),
    children: arr<{ id: string; name: string }>(raw.children).filter((c) => c && typeof c.id === "string"),
  };
}

/** POST /api/categories/:id/move {parentId} —— 子分类换父（ID 不变）。 */
export async function moveCategory(id: string, parentId: string): Promise<CategoryNode> {
  const raw = rec(await request<unknown>("POST", "/categories/" + encodeURIComponent(id) + "/move", { parentId }));
  return rec(raw.category) as unknown as CategoryNode;
}

/** POST /api/categories/:id/merge {intoId} —— 素材与建议迁到目标后删源（事务）。 */
export async function mergeCategory(id: string, intoId: string): Promise<{ moved: number; movedSuggestions?: number; deleted: number }> {
  const raw = rec(await request<unknown>("POST", "/categories/" + encodeURIComponent(id) + "/merge", { intoId }));
  return {
    moved: numOr(raw.moved, 0),
    movedSuggestions: raw.movedSuggestions === undefined ? undefined : numOr(raw.movedSuggestions, 0),
    deleted: numOr(raw.deleted, 0),
  };
}

/** 条目级分类端点的响应可能是裸 ItemDetail，也可能是 { item: ItemDetail }（契约写的是后者）。 */
function detailFrom(raw: unknown): ItemDetailWeb {
  const outer = rec(raw);
  const inner = rec(outer.item);
  const pick = Array.isArray(outer.images) ? outer : Array.isArray(inner.images) ? inner : outer;
  const d = pick as unknown as ItemDetailWeb;
  return { ...d, images: arr(d.images), assets: arr(d.assets), avatars: arr(d.avatars), tags: arr(d.tags) };
}

/** POST /api/items/:id/category —— categoryId=null 清除归属（source='manual'）。 */
export async function setItemCategory(id: number, body: { categoryId: string | null; subCategoryId?: string | null }): Promise<ItemDetailWeb> {
  return detailFrom(await request<unknown>("POST", "/items/" + id + "/category", body));
}
/** POST /api/items/:id/category/accept —— 采纳当前建议（source='confirmed'，清建议）。 */
export async function acceptCategorySuggestion(id: number): Promise<ItemDetailWeb> {
  return detailFrom(await request<unknown>("POST", "/items/" + id + "/category/accept", {}));
}
/** POST /api/items/:id/category/dismiss —— 忽略建议（只清建议，不动归属）。 */
export async function dismissCategorySuggestion(id: number): Promise<ItemDetailWeb> {
  return detailFrom(await request<unknown>("POST", "/items/" + id + "/category/dismiss", {}));
}
/** POST /api/items/category/batch —— mode: set(默认) | clear_sub | resuggest。 */
export async function batchSetItemCategory(body: {
  itemIds: number[];
  categoryId?: string | null;
  subCategoryId?: string | null;
  mode?: "set" | "clear_sub" | "resuggest";
}): Promise<BatchCategoryResponse> {
  const raw = rec(await request<unknown>("POST", "/items/category/batch", body));
  return {
    updated: numOr(raw.updated, 0),
    failed: arr<{ itemId: number; reason: string }>(raw.failed),
    requested: numOr(raw.requested, body.itemIds.length),
  };
}
/** POST /api/categories/reclassify —— 自动分类（apply=false 只出建议；onlyUncategorized 只处理未分类）。 */
export async function reclassifyCategories(body: {
  itemIds?: number[];
  onlyUncategorized?: boolean;
  apply?: boolean;
  all?: boolean;
  limit?: number;
}): Promise<ReclassifyResponse> {
  const raw = rec(await request<unknown>("POST", "/categories/reclassify", body, { timeoutMs: 120000 }));
  return {
    scanned: numOr(raw.scanned, 0),
    applied: numOr(raw.applied, 0),
    suggested: numOr(raw.suggested, 0),
    cleared: numOr(raw.cleared, 0),
    skipped: numOr(raw.skipped, 0),
    protected: numOr(raw.protected, 0),
    results: arr<ReclassifyResponse["results"][number]>(raw.results),
  };
}
/** PUT /api/categories/config —— 自动/建议阈值（0..1，suggest 不得高于 auto）。 */
export async function setCategoryConfig(patch: { autoThreshold?: number; suggestThreshold?: number }): Promise<CategoryConfig> {
  const raw = rec(await request<unknown>("PUT", "/categories/config", patch));
  return { autoThreshold: num01(raw.autoThreshold, 0.75), suggestThreshold: num01(raw.suggestThreshold, 0.4) };
}
/** POST /api/categories —— 新建分类（分类树管理用；UI 暂未接线）。 */
export async function createCategory(body: { id?: string; name: string; parentId?: string | null; sort?: number }): Promise<CategoryNode> {
  const raw = rec(await request<unknown>("POST", "/categories", body));
  return (rec(raw.category) as unknown as CategoryNode);
}
/** PATCH /api/categories/:id —— 改名/排序/启停/换父级。 */
export async function updateCategory(id: string, patch: { name?: string; parentId?: string | null; sort?: number; enabled?: boolean }): Promise<CategoryNode> {
  const raw = rec(await request<unknown>("PATCH", "/categories/" + encodeURIComponent(id), patch));
  return (rec(raw.category) as unknown as CategoryNode);
}
/**
 * DELETE /api/categories/:id?transferTo=<id|none> —— 素材先转移再删；系统分类 409。
 * transferTo 缺省（undefined）时不带该参数，服务端按"未分类"处理。
 */
export function deleteCategory(id: string, transferTo?: string | null): Promise<{ moved: number; movedSubs: number; deleted?: number }> {
  const q = transferTo === undefined ? "" : "?transferTo=" + encodeURIComponent(transferTo === null ? "none" : transferTo);
  return request("DELETE", "/categories/" + encodeURIComponent(id) + q);
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
export interface CollectionMember { id: number; title: string; status: ItemStatus; sourceSite: SourceSite }
/** 套装成员（用于"把套装里的其他条目合并到本条"）。 */
export function getCollection(id: number): Promise<{ id: number; itemIds: number[]; items: CollectionMember[] }> {
  return request("GET", "/collections/" + id);
}
export function createCollection(name: string, itemIds?: number[]): Promise<{ id: number; name: string; itemCount: number }> { return request("POST", "/collections", { name, itemIds }); }
/** 删掉整个套装（只删分组，不动条目本身）。 */
export function deleteCollection(id: number): Promise<unknown> { return request("DELETE", "/collections/" + id); }
export function addToCollection(id: number, itemIds: number[]): Promise<unknown> { return request("POST", "/collections/" + id + "/items", { itemIds }); }
export function removeFromCollection(id: number, itemId: number): Promise<unknown> { return request("DELETE", "/collections/" + id + "/items/" + itemId); }
/** 合并条目：把 source 的压缩包/图片/模型/标签/历史并到 target，source 进回收站 */
export function mergeItems(sourceId: number, targetId: number): Promise<unknown> { return request("POST", "/items/merge", { sourceId, targetId }); }
/** 把已有（扫库建出来的）本地条目关联到 BOOTH 商品：补元数据 + 抓图集。merge=true 时合并到已存在的同商品条目。 */
// ---------- Unity 编辑器桥（把素材真正导入当前打开的工程）----------
export interface UnityEditorInfoWeb {
  endpoint: string; serverName: string; dataPath: string; projectPath: string; projectName: string;
  unityVersion: string; isPlaying: boolean; isCompiling: boolean; scenePath: string;
}
/** 从包名/工程路径里认出来的 avatar。 */
export interface UnityAvatarHintWeb { id: number; name: string; via: string }
export interface UnityStatusWeb {
  ok: boolean; endpoint: string; serverName?: string; error?: string; editor?: UnityEditorInfoWeb;
  projectAvatar?: UnityAvatarHintWeb | null; projectId?: number | null; registered?: boolean; candidates: string[];
}
export interface UnityPackageWeb {
  key: string; label: string; assetId: number; container: string; sourcePath: string;
  entryPath: string | null; innerEntryPath: string | null; size: number; note?: string;
  /** 这个包是给哪个 avatar 的（认不出来是 null） */
  avatar?: UnityAvatarHintWeb | null;
  /** 是否匹配"当前打开那个工程"的 avatar */
  matched?: boolean;
}
export interface UnityImportWeb {
  ok: boolean; endpoint: string; autoMatched?: boolean;
  project: { id: number; name: string; path: string; unityVersion: string; avatar?: UnityAvatarHintWeb | null };
  imported: { key: string; label: string; stagedPath: string; bytes: number }[];
  queued: string[]; failed: string[]; consoleErrors: string[]; consoleCleared?: boolean; raw: string;
}
/** 探测当前打开的 Unity 编辑器（MCP for Unity）。Unity 没开时返回 {ok:false}，不抛错。 */
export function unityStatus(): Promise<UnityStatusWeb> { return request("GET", "/unity/status", undefined, { timeoutMs: 12000 }); }
/** 这个条目里能导入 Unity 的 .unitypackage（压缩包内的、zip 套 zip 的都列）。传 projectPath 时会标出"哪些是当前工程那个 avatar 的"。 */
export function unityPackages(itemId: number, projectPath?: string | null, refresh = false): Promise<{ itemId: number; projectAvatar: UnityAvatarHintWeb | null; scanErrors?: number; packages: UnityPackageWeb[] }> {
  return request("GET", "/unity/packages" + queryString({ itemId, project: projectPath ?? undefined, refresh: refresh ? 1 : undefined }), undefined, { timeoutMs: 150000 });
}
/** 真正导入到当前打开的 Unity 工程；keys 省略 = 全部导入。 */
export function unityImport(itemId: number, keys?: string[]): Promise<UnityImportWeb> {
  return request("POST", "/unity/import", { itemId, keys }, { timeoutMs: 180000 });
}
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
/** 按素材内容校正：只保留有包内证据（archive_path/unitypackage_path/filename）的适配模型。 */
export function pruneItemAvatars(id: number): Promise<{ ok: boolean; removed: { id: number; name: string; sources: string[] }[]; kept: string[]; note?: string }> {
  return request("POST", "/items/" + id + "/avatars/prune", {});
}

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

// ---------------- 检查更新 ----------------
/**
 * 检查应用更新（GET /api/update-check?force=1）。
 * 契约：**永远 200**，失败也是 {ok:false,error,current,checkedAt}；这里再做一层形状归一化。
 * 内置 mock 模式下后端不可达 → 直接返回 ok:false 的降级对象（不抛，按钮只 toast 一行）。
 */
export async function checkAppUpdate(force = false): Promise<UpdateCheckResponse> {
  const nowIso = (): string => new Date().toISOString();
  if (mode === "mock") {
    return { ok: false, error: "内置 mock 数据模式：后端不可达，暂时无法检查更新", current: "?", checkedAt: nowIso() };
  }
  try {
    const raw = rec(await request<unknown>("GET", "/update-check" + queryString({ force: force ? 1 : undefined })));
    if (raw.ok === false) {
      return {
        ok: false,
        error: typeof raw.error === "string" && raw.error ? raw.error : "检查更新失败（服务端没给出原因）",
        current: typeof raw.current === "string" ? raw.current : "?",
        checkedAt: typeof raw.checkedAt === "string" ? raw.checkedAt : nowIso(),
      };
    }
    return {
      ok: true,
      current: typeof raw.current === "string" ? raw.current : "?",
      checkedAt: typeof raw.checkedAt === "string" ? raw.checkedAt : nowIso(),
      latest: typeof raw.latest === "string" ? raw.latest : undefined,
      hasUpdate: raw.hasUpdate === true,
      publishedAt: typeof raw.publishedAt === "string" ? raw.publishedAt : null,
      url: typeof raw.url === "string" ? raw.url : undefined,
      notes: typeof raw.notes === "string" ? raw.notes : "",
      assetName: typeof raw.assetName === "string" ? raw.assetName : null,
      assetSize: Number.isFinite(Number(raw.assetSize)) ? Number(raw.assetSize) : null,
      fromCache: raw.fromCache === true,
    };
  } catch (e) {
    return { ok: false, error: describeError(e), current: "?", checkedAt: nowIso() };
  }
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
export async function getAssetTree(id: number, opts: { nested?: string } = {}): Promise<AssetTreeResponse> {
  const q = opts.nested ? "?nested=" + encodeURIComponent(opts.nested) : "";
  const raw = await request<AssetTreeResponse>("GET", "/assets/" + id + "/tree" + q);
  return { ...(raw as AssetTreeResponse), entries: arr<ArchiveEntry>(raw?.entries) };
}
export async function getUnityPackage(id: number): Promise<UnityPackageResponse> {
  const raw = await request<UnityPackageResponse>("GET", "/assets/" + id + "/unitypackage");
  const assets = arr<UnityPackageAsset>(raw?.assets);
  const byTypeRaw = rec(raw).byType;
  const byType = byTypeRaw && typeof byTypeRaw === "object" && !Array.isArray(byTypeRaw)
    ? (byTypeRaw as Record<string, number>)
    : undefined;
  const pkgs = rec(raw).packages;
  return {
    ...(raw as UnityPackageResponse), assets, total: numOr(rec(raw).total, assets.length), byType,
    packages: Array.isArray(pkgs) ? (pkgs as UnityPackageResponse["packages"]) : undefined,
    container: typeof rec(raw).container === "string" ? String(rec(raw).container) : undefined,
  };
}
export async function reindexAsset(id: number): Promise<JobIdResponse> {
  return jobIdResponse(await request<unknown>("POST", "/assets/" + id + "/reindex"));
}

export interface EntryPreview { contentType: string; url: string | null; text: string | null; bytes?: number }

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
      return { contentType: ct, url: URL.createObjectURL(blob), text: null, bytes: blob.size };
    }
    const buf = await res.arrayBuffer();
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, 65536));
    return { contentType: ct, url: null, text, bytes: buf.byteLength };
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

/**
 * 这个条目被哪些工程**真的用到**（GUID 求交，不是 project_imports 的登记）。
 * 后端没有这个端点（旧版）或还没扫过 → 返回空数组，调用方静默（不弹错、不崩）。
 * 形状一律经 rec/arr/numOr 归一化：裸数组、{projects:[]}、缺字段都吃。
 */
export async function itemUsage(itemId: number): Promise<ItemUsageResponse> {
  const raw = await request<unknown>("GET", "/items/" + itemId + "/usage", undefined, { timeoutMs: 15000 });
  const r = rec(raw);
  const projects = arr<Record<string, unknown>>(r.projects).map((p) => ({
    projectId: numOr(p.projectId, 0),
    name: typeof p.name === "string" ? p.name : "",
    path: typeof p.path === "string" ? p.path : "",
    files: numOr(p.files, 0),
    paths: arr<unknown>(p.paths).map((x) => String(x)),
  }));
  return { itemId: numOr(r.itemId, itemId), projects };
}

/**
 * 扫这个工程 Assets/ 的 GUID 并与素材库求交（会写 project_refs；后端可能要跑几十秒 → 120s 超时）。
 * 未实现的旧后端 → 404 ApiError，调用方自己兜住。
 */
export async function scanProjectUsage(projectId: number): Promise<ScanUsageResponse> {
  const raw = await request<unknown>("POST", "/projects/" + projectId + "/scan-usage", undefined, { timeoutMs: 120000 });
  const r = rec(raw);
  return {
    projectId: numOr(r.projectId, projectId),
    scannedFiles: numOr(r.scannedFiles, 0),
    guidCount: numOr(r.guidCount, 0),
    matchedGuids: numOr(r.matchedGuids, 0),
    matchedItems: numOr(r.matchedItems, 0),
    matchedAssets: numOr(r.matchedAssets, 0),
    truncated: r.truncated === true,
    remaining: r.remaining === true,
    ms: numOr(r.ms, 0),
  };
}

// ---------------- 其它 ----------------
export async function listRoots(): Promise<RootsResponse> {
  return { roots: pickArray<LibraryRootRow>(await request<unknown>("GET", "/roots"), "roots") };
}
/** GET /api/tags —— v3 起契约补 color/sort/itemCount（缺 itemCount 时前端只不显示计数）。 */
export async function listTags(): Promise<TagsResponse> {
  const raw = pickArray<TagListRow>(await request<unknown>("GET", "/tags"), "tags");
  return {
    tags: raw.map((t) => ({
      id: numOr(t.id, 0),
      name: typeof t.name === "string" ? t.name : String(t.name ?? ""),
      namespace: typeof t.namespace === "string" ? t.namespace : null,
      color: typeof t.color === "string" ? t.color : null,
      sort: numOr(t.sort, 0),
      itemCount: t.itemCount === undefined ? undefined : numOr(t.itemCount, 0),
    })),
  };
}
/** POST /api/tags {name,color?} —— 幂等：同名（同一 namespace）直接返回已存在的那个。 */
export async function createTag(body: { name: string; color?: string | null; namespace?: string | null }): Promise<TagListRow> {
  const raw = rec(await request<unknown>("POST", "/tags", body));
  const tag = rec(raw.tag ?? raw);
  return {
    id: numOr(tag.id, 0), name: String(tag.name ?? body.name),
    namespace: typeof tag.namespace === "string" ? tag.namespace : null,
    color: typeof tag.color === "string" ? tag.color : null, sort: numOr(tag.sort, 0),
    itemCount: tag.itemCount === undefined ? undefined : numOr(tag.itemCount, 0),
  };
}
/** PATCH /api/tags/:id {name?,color?} —— 素材关联按 id 跟随，改名不丢关联。 */
export async function updateTag(id: number, patch: { name?: string; color?: string | null }): Promise<TagListRow> {
  const raw = rec(await request<unknown>("PATCH", "/tags/" + id, patch));
  const tag = rec(raw.tag ?? raw);
  return {
    id: numOr(tag.id, id), name: String(tag.name ?? ""),
    namespace: typeof tag.namespace === "string" ? tag.namespace : null,
    color: typeof tag.color === "string" ? tag.color : null, sort: numOr(tag.sort, 0),
    itemCount: tag.itemCount === undefined ? undefined : numOr(tag.itemCount, 0),
  };
}
/** DELETE /api/tags/:id → { removed }（同时删 item_tags 关联；不删素材、不删文件）。 */
export async function deleteTag(id: number): Promise<{ removed: number }> {
  const raw = rec(await request<unknown>("DELETE", "/tags/" + id));
  return { removed: numOr(raw.removed, 0) };
}
export function getStats(): Promise<StatsResponse> { return request("GET", "/stats"); }

// ---------------- 疑似重复 ----------------
/**
 * 后端契约（已冻结）：
 *   GET  /items/:id/duplicates?min&limit → { itemId, min, matches }
 *   GET  /duplicates?min&limit           → { min, groups }
 *   POST /duplicates/recompute           → { scanned, updated }
 * 后端可能还没上线（mock 模式下这些路由一律 404），故全部字段做归一化 + 调用方负责静默兜底。
 */
const DUP_LEVELS: DuplicateLevel[] = ["exact", "same-content", "near"];

function dupLevel(x: unknown): DuplicateLevel {
  return typeof x === "string" && (DUP_LEVELS as string[]).includes(x) ? (x as DuplicateLevel) : "near";
}
function dupStr(x: unknown): string { return typeof x === "string" ? x : ""; }
function dupStrOrNull(x: unknown): string | null { return typeof x === "string" && x ? x : null; }

function dupFiles(x: unknown): DuplicateFileDiff[] {
  return arr<unknown>(x).map((e) => {
    const er = rec(e);
    return { path: dupStr(er.path), size: numOr(er.size, 0) };
  });
}
function dupDiff(x: unknown): DuplicateDiff {
  const r = rec(x);
  return { added: dupFiles(r.added), removed: dupFiles(r.removed), changed: dupFiles(r.changed) };
}
function dupMatch(x: unknown): DuplicateMatch {
  const r = rec(x);
  return {
    otherAssetId: numOr(r.otherAssetId, 0),
    otherItemId: numOr(r.otherItemId, 0),
    otherTitle: dupStr(r.otherTitle),
    otherPath: dupStr(r.otherPath),
    otherVersionKey: dupStrOrNull(r.otherVersionKey),
    similarity: numOr(r.similarity, 0),
    level: dupLevel(r.level),
    reason: dupStr(r.reason),
    diff: dupDiff(r.diff),
  };
}
function dupGroupItem(x: unknown): DuplicateGroupItem {
  const r = rec(x);
  return {
    itemId: numOr(r.itemId, 0),
    title: dupStr(r.title),
    assetId: numOr(r.assetId, 0),
    path: dupStr(r.path),
    size: numOr(r.size, 0),
    versionKey: dupStrOrNull(r.versionKey),
  };
}

/** 某个条目在库里的疑似重复（min 默认服务端 0.9）。 */
export async function getItemDuplicates(itemId: number, min?: number): Promise<ItemDuplicatesResponse> {
  const raw = await request<unknown>("GET", "/items/" + itemId + "/duplicates" + queryString({ min }));
  const r = rec(raw);
  return {
    itemId: numOr(r.itemId, itemId),
    min: numOr(r.min, min ?? 0.9),
    matches: pickArray<unknown>(raw, "matches").map(dupMatch),
  };
}

/** 库级重复组（跨条目的疑似重复聚类）。 */
export async function getDuplicateGroups(min?: number, limit = 100): Promise<DuplicateGroupsResponse> {
  const raw = await request<unknown>("GET", "/duplicates" + queryString({ min, limit }));
  const r = rec(raw);
  const groups: DuplicateGroup[] = pickArray<unknown>(raw, "groups").map((g) => {
    const gr = rec(g);
    return {
      key: dupStr(gr.key),
      similarity: numOr(gr.similarity, 0),
      items: pickArray<unknown>(g, "items").map(dupGroupItem),
    };
  });
  return { min: numOr(r.min, min ?? 0.9), groups };
}

function relLevel(x: unknown): RelatedLevel { return x === "same-product" ? "same-product" : "likely"; }
function relatedMatch(x: unknown): RelatedMatch {
  const r = rec(x);
  return {
    itemId: numOr(r.itemId, 0),
    title: dupStr(r.title),
    score: numOr(r.score, 0),
    level: relLevel(r.level),
    shared: arr<unknown>(r.shared).map((s) => String(s)).filter(Boolean),
    reason: dupStr(r.reason),
    assetCount: numOr(r.assetCount, 0),
    imageCount: numOr(r.imageCount, 0),
  };
}

/**
 * 疑似同商品（模型包 / 材质包 / DLC 分开打包）：后端端点不存在（mock/旧版）或请求失败时由调用方静默。
 */
export async function getRelatedItems(itemId: number, min?: number): Promise<ItemRelatedResponse> {
  const raw = await request<unknown>("GET", "/items/" + itemId + "/related" + queryString({ min }));
  const r = rec(raw);
  return {
    itemId: numOr(r.itemId, itemId),
    min: numOr(r.min, min ?? 0.6),
    matches: pickArray<unknown>(raw, "matches").map(relatedMatch),
  };
}

/** 重算全部资产的重复签名（可能很慢，给 120s 超时）。 */
export async function recomputeSignatures(): Promise<RecomputeResponse> {
  const raw = await request<unknown>("POST", "/duplicates/recompute", undefined, { timeoutMs: 120000 });
  const r = rec(raw);
  return { scanned: numOr(r.scanned, 0), updated: numOr(r.updated, 0) };
}

export type { ArchiveEntry, AssetRow, BoothItemMeta, ContainerKind, ItemStatus, JobRow, LibraryRootRow, RootMode, SourceSite, TagRow };