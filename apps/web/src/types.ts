/**
 * Web 侧 API 形状 —— 严格按 docs/api.md (FROZEN v1) + packages/core/src/contracts.ts
 * 契约类型从 @core/contracts 只读复用，不重新定义字段名。
 */
import type {
  ArchiveEntry, AssetAvatarRow, AssetRow, AvatarAliasRow, AvatarKind, AvatarMatch,
  BoothItemMeta, CategoryLevel, CategoryNode, ContainerKind, ImageRow, ItemCard, ItemRow, ItemStatus, JobEventRow,
  JobRow, LibraryRootRow, SourceSite, TagRow, UnityPackageAsset, UpdateKind,
} from "@core/contracts";

export type {
  ArchiveEntry, AssetAvatarRow, AssetRow, AvatarAliasRow, AvatarKind, AvatarMatch,
  BoothItemMeta, ContainerKind, ImageRow, ItemRow, ItemStatus, JobEventRow, JobRow,
  LibraryRootRow, SourceSite, TagRow, UnityPackageAsset, UpdateKind,
};

// ---------- 物品分类（docs/categories.md §4；类型真源在 @core/contracts，这里只再导出） ----------
export type {
  CategoryAssignment, CategoryDef, CategoryEvidenceHit, CategoryLevel, CategoryNode,
  CategoryRefSource, CategorySuggestion,
} from "@core/contracts";

/** ItemCard.avatars 的契约元素是 {id,name,match}；证据字段是附加可选项，缺失时 UI 显式标注。 */
export interface CompatAvatar {
  id: number;
  name: string;
  match: AvatarMatch;
  confidence?: number | null;
  evidence?: string | null;
  source?: string | null;
}

export interface ItemCardWeb extends Omit<ItemCard, "avatars"> {
  avatars: CompatAvatar[];
}

/** /items/:id —— ItemDetail（item/images/assets/avatars/tags/updates），images 额外带可用的媒体 URL。 */
export interface ImageRowWeb extends ImageRow {
  url?: string | null;
  thumbUrl?: string | null;
}

export interface UpdateRow {
  id: number;
  item_id: number;
  kind: UpdateKind;
  detail: string | null;
  seen: number;
  created_at: string;
}

export interface ItemDetailWeb extends ItemCardWeb { collections?: { id: number; name: string }[];
  item: ItemRow;
  images: ImageRowWeb[];
  assets: AssetRow[];
  notes: string | null;
  description: string | null;
  updates?: UpdateRow[];
}

/** GET /avatars —— AvatarCard 含 itemCount / owned / aliases（api.md）。 */
export interface AvatarCard {
  id: number;
  name: string;
  kind: AvatarKind;
  owned: number;
  coverPath: string | null;
  itemCount: number;
  aliases: string[];
  boothItemId: string | null;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  dbPath: string;
  roots: LibraryRootRow[];
  counts: Record<string, number>;
}

export interface ItemsResponse {
  total: number;
  items: ItemCardWeb[];
}
export interface AvatarsResponse {
  avatars: AvatarCard[];
}
export interface JobsResponse {
  jobs: JobRow[];
}
export interface RootsResponse {
  roots: LibraryRootRow[];
}
/** 收件箱监听的一条（GET/POST/DELETE /api/watch）。 */
export interface WatchEntry { path: string; enabled: boolean }
/** GET/PUT /api/settings（token 只回「有没有配」，不回值）。 */
export interface SettingsResponse {
  downloadRoot: string;
  dataDir: string;
  dbPath: string;
  watchPaths: WatchEntry[];
  unityMcpUrl: string;
  unityMcpCandidates: string[];
  updateRepo: string;
  updateTokenSet: boolean;
}
export interface TagsResponse {
  tags: TagRow[];
}
export interface StatsResponse {
  items: number;
  assets: number;
  bytes: number;
  avatars: number;
  byCategory: { name: string; count: number }[];
  byAvatar: { id: number; name: string; count: number }[];
}
export interface AssetDetailResponse extends AssetRow {
  avatars: AssetAvatarRow[];
}
export interface AssetTreeResponse {
  container: ContainerKind;
  entries: ArchiveEntry[];
  truncated?: boolean;
  passwordProtected?: boolean;
  note?: string;
  /** ?nested=<包内路径> 时返回的是内层压缩包的目录 */
  path?: string;
}
/** 压缩包里解析出来的那个 .unitypackage（一个压缩包里可能有好几个）。 */
export interface UnityPackageInside {
  label: string;
  source: string;
  size: number;
  assets: number;
  note?: string;
}
export interface UnityPackageResponse {
  assets: UnityPackageAsset[];
  truncated?: boolean;
  /** 服务端已算好的总数/类型统计（实测返回 {assets,total,byType}），缺失时前端自行统计 */
  total?: number;
  byType?: Record<string, number>;
  /** 这个资产里包含的 .unitypackage（容器是压缩包时非空） */
  packages?: UnityPackageInside[];
  container?: string;
}

/** api.md 之外的扩展：POST /scan {dryRun:true} 只读预览（lead 已确认服务端支持） */
export interface ScanPlanItem {
  title: string;
  sourceSite: SourceSite;
  sourceItemId: string | null;
  confidence: number | null;
  assets: number;
}
export interface ScanDryRunResponse {
  items: ScanPlanItem[];
}
export interface AliasResponse {
  alias?: AvatarAliasRow;
  pendingConfirm?: boolean;
  conflictWith?: { avatarId: number; name: string } | null;
}
export interface JobActionResponse {
  job: JobRow;
}
export interface JobIdResponse {
  jobId: number;
  itemId?: number;
}

// ---------------- 索引流水线（v0.6.0 §13） ----------------
/**
 * 阶段顺序即流水线真实顺序（hash → archive → unitypackage → thumbs → meta → categorize → fts）。
 * 服务端给的是字符串，这里保留字面量便于穷举渲染，遇到未知值按原样显示（不吞）。
 */
export type PipelineStage = "hash" | "archive" | "unitypackage" | "thumbs" | "meta" | "categorize" | "fts";
export type PipelineTaskState = "queued" | "running" | "waiting_retry" | "failed" | "done" | "cancelled" | "skipped";

export interface PipelineStageStat {
  stage: PipelineStage;
  queued: number;
  running: number;
  waitingRetry: number;
  failed: number;
  done: number;
  skipped: number;
  avgMs: number | null;
}
export interface PipelineCache {
  entries: number;
  bytes: number;
  hits: number;
  /** 服务端可能给 0..1 也可能给 0..100，渲染层统一归一化 */
  hitRate: number;
  maxBytes: number;
}
export interface PipelineMemory {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
}
export interface PipelineLastError {
  at: string;
  stage: string;
  assetId: number;
  message: string;
}
/** GET /api/pipeline */
export interface PipelineOverview {
  started: boolean;
  paused: boolean;
  startedAt: string;
  running: number;
  queued: number;
  waitingRetry: number;
  failed: number;
  done: number;
  cancelled: number;
  skipped: number;
  stages: PipelineStageStat[];
  cache: PipelineCache;
  memory: PipelineMemory;
  processed: number;
  failures: number;
  lastError: PipelineLastError | null;
  limits: Record<string, unknown>;
  nonDefaultLimits: Record<string, unknown>;
}
/** GET /api/pipeline/tasks —— path/size 是服务端 join 出来的可选便利字段 */
export interface PipelineTask {
  id: number;
  asset_id: number;
  item_id: number | null;
  stage: PipelineStage | string;
  state: PipelineTaskState | string;
  priority: number;
  attempts: number;
  max_attempts: number;
  bytes_done: number;
  bytes_total: number | null;
  items_done: number;
  items_total: number | null;
  error_code: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  next_retry_at: string | null;
  path?: string | null;
  size?: number | null;
}
/** GET /api/pipeline/events —— task/asset/item 三个 id 都可能为 null（GC、守卫类事件） */
export interface PipelineEvent {
  id: number;
  at: string;
  task_id: number | null;
  asset_id: number | null;
  item_id: number | null;
  stage: string | null;
  event: string;
  detail: string | null;
}

/** api.md: GET /booth/peek → 只读预览（不落库）：BoothItemMeta 摘要 */
export interface BoothPeekResponse extends BoothItemMeta {
  inLibrary?: { itemId: number; title: string } | null;
}

export type AvatarMatchMode = AvatarMatch;
export type ViewMode = "live" | "mock";

export interface ItemQuery {
  q?: string;
  avatar?: number[];
  avatarMatch?: AvatarMatch;
  ownedOnly?: boolean;
  site?: SourceSite | "";
  status?: ItemStatus | "";
  tag?: string;
  container?: ContainerKind | "";
  /** 是否已导入 Unity 工程（服务端按 project_imports 过滤） */
  imported?: 1 | 0;
  /** 物品分类多选（URL 键是 catIds；命中任一/全部由 categoryMatch 决定） */
  categoryIds?: string[];
  categoryMatch?: "any" | "all";
  /** 只看未分类（cat_id IS NULL，v3 起等价于分类树里的系统分类「未分类」） */
  uncategorized?: boolean;
  /** 只看有待确认的自动分类建议 */
  pendingCategory?: boolean;
  /** 标签多选（URL 键是 tags=a,b；与旧的单值 tag 并存，两者都会被服务端 OR 到同一条件上） */
  tags?: string[];
  /** 多标签语义：any=命中任一（默认）；all=必须同时具有全部 */
  tagsMatch?: "any" | "all";
  /** 只看收藏（URL 键 favoriteOnly=1） */
  favoriteOnly?: boolean;
  sort?: "updated" | "title" | "size";
  limit?: number;
  offset?: number;
}

// ---------------- 物品分类（GET /api/categories 等，docs/categories.md §4） ----------------
/** 分类自动/建议阈值（settings：category_auto_threshold / category_suggest_threshold）。 */
export interface CategoryConfig {
  autoThreshold: number;
  suggestThreshold: number;
}
/** 单个分类的统计（与 repo.categoryStats().counts 同形）。 */
export interface CategoryStatCount {
  id: string;
  name: string;
  parentId: string | null;
  count: number;
  topCount: number;
  owned: number;
  favorite: number;
}
export interface CategoryStats {
  counts: CategoryStatCount[];
  uncategorized: number;
  pending: number;
  total: number;
  missingFiles: number;
}
/**
 * GET /api/categories/counts?<与 /api/items 相同的筛选参数> → { all, uncategorized, tops, subs }
 * 口径：**当前筛选下**的计数（分类筛选本身不参与，否则只会剩被选中的那个分类）。
 * 分类管理页用 GET /api/categories 的全局 stats，两者别混。
 */
export interface CategoryCounts {
  all: number;
  uncategorized: number;
  /** 一级分类 id → 条目数（含其下子分类的归属） */
  tops: Record<string, number>;
  /** 子分类 id → 条目数 */
  subs: Record<string, number>;
}
/** GET /api/categories/:id/impact —— 删除/合并前的影响面。 */
export interface CategoryImpact {
  /** 该分类（一级含其子分类）下的条目数 */
  items: number;
  /** 只算直接挂在该节点上的条目数（服务端给，mock 也给） */
  direct?: number;
  /** 子分类数 */
  subs: number;
  /** 引用了该分类（或该分类建议）的条目数 */
  suggestions: number;
  /** 子分类清单（服务端给） */
  children?: { id: string; name: string }[];
}
/** 扫描变更中心（M1）：一轮扫描的逐条变化类型。 */
export type PreviewChange = "new" | "unchanged" | "changed" | "missing" | "duplicate_suspected" | "unreadable" | "error";
export interface ScanPreviewCounts { total: number; new: number; unchanged: number; changed: number; missing: number; duplicate_suspected: number; unreadable: number; error: number }
export interface ScanPreviewItem {
  id: number; preview_id: number; item_key: string; path: string; path_norm: string; change: PreviewChange;
  size: number | null; mtime: string | null; prev_size: number | null; prev_mtime: string | null;
  asset_id: number | null; item_id: number | null; container: string | null; kind: string | null;
  decision: "pending" | "accept" | "skip"; applied: number; error: string | null; detail_json: string | null;
}
export interface ScanPreview {
  id: number; uid: string; root_id: number | null; path: string; path_norm: string; deep: number;
  state: string; plan_hash: string | null; truncated: number; complete: number;
  files: number; dirs: number; bytes: number; error_count: number;
  counts: ScanPreviewCounts | null; scan: { readability?: unknown; missingProposed?: boolean; reasons?: string[] } | null;
  error: string | null; apply_job_id: number | null;
  created_at: string; finished_at: string | null; expires_at: string | null;
  itemCounts: { total: number; accepted: number; applied: number; pending: number };
}

/** GET /api/tags 的一条：TagRow + 被多少条目使用（契约 §4 补 itemCount）。 */
export type TagListRow = TagRow & { itemCount?: number };

/** GET /api/categories */
export interface CategoriesResponse {
  categories: CategoryNode[];
  stats: CategoryStats;
  config: CategoryConfig;
}
/** POST /api/items/category/batch */
export interface BatchCategoryResponse {
  updated: number;
  failed: { itemId: number; reason: string }[];
  requested: number;
}
/** POST /api/categories/reclassify 的一条结果 */
export interface ReclassifyRow {
  itemId: number;
  categoryId: string | null;
  subCategoryId: string | null;
  confidence: number;
  level: CategoryLevel;
  applied: boolean;
  protected: boolean;
  reason: string;
}
export interface ReclassifyResponse {
  scanned: number;
  applied: number;
  suggested: number;
  cleared: number;
  skipped: number;
  protected: number;
  results: ReclassifyRow[];
}

// ---------------- 疑似重复（/api/duplicates*，后端契约已冻结） ----------------
/** exact=完全相同 / same-content=内容一致 / near=高度相似 */
export type DuplicateLevel = "exact" | "same-content" | "near";

/** 文件级差异里的一条（路径 + 字节数）。 */
export interface DuplicateFileDiff {
  path: string;
  size: number;
}
export interface DuplicateDiff {
  added: DuplicateFileDiff[];
  removed: DuplicateFileDiff[];
  changed: DuplicateFileDiff[];
}

/** GET /items/:id/duplicates 的一条匹配。 */
export interface DuplicateMatch {
  otherAssetId: number;
  otherItemId: number;
  otherTitle: string;
  otherPath: string;
  otherVersionKey: string | null;
  /** 0..1，四位小数 */
  similarity: number;
  level: DuplicateLevel;
  /** 中文一句话，已含"新增 2 / 删除 0 / 修改 1" */
  reason: string;
  diff: DuplicateDiff;
}
export interface ItemDuplicatesResponse {
  itemId: number;
  min: number;
  matches: DuplicateMatch[];
}

/** GET /duplicates 的库级重复组。 */
export interface DuplicateGroupItem {
  itemId: number;
  title: string;
  assetId: number;
  path: string;
  size: number;
  versionKey: string | null;
}
export interface DuplicateGroup {
  key: string;
  similarity: number;
  items: DuplicateGroupItem[];
}
export interface DuplicateGroupsResponse {
  min: number;
  groups: DuplicateGroup[];
}

/** POST /duplicates/recompute */
export interface RecomputeResponse {
  scanned: number;
  updated: number;
}

// ---------------- 检查更新（GET /api/update-check?force=1） ----------------
/**
 * 应用自身版本的更新检查结果。契约：**永远 200**，失败也是 `ok:false`（绝不 500）。
 * ok=false 时只有 error/current/checkedAt 有意义。
 */
export interface UpdateCheckResponse {
  ok: boolean;
  /** 当前运行版本（服务端 deps.version，正常就是 package.json version） */
  current: string;
  /** 服务端完成本次检查/读缓存的时间（ISO） */
  checkedAt: string;
  /** ok=true：Release tag 去掉 v 前缀后的版本 */
  latest?: string;
  hasUpdate?: boolean;
  /** ISO 或 null */
  publishedAt?: string | null;
  /** Release 页面链接 */
  url?: string;
  /** Release body 前 2000 字 */
  notes?: string;
  /** 便携包文件名（挑不到就是 null） */
  assetName?: string | null;
  /** 便携包字节数（挑不到就是 null） */
  assetSize?: number | null;
  /** 本次是否来自 6h 缓存 */
  fromCache?: boolean;
  /** ok=false 时的中文一行错误 */
  error?: string;
}

// ---------------- 疑似同商品（/api/items/:id/related） ----------------
/** same-product = 认成同一商品（产品名片段完全一致）；likely = 疑似（片段高度重合）。 */
export type RelatedLevel = "same-product" | "likely";

/** GET /items/:id/related 的一条匹配。 */
export interface RelatedMatch {
  itemId: number;
  title: string;
  /** 0..1，四位小数（1.0 same-product / 0.75 likely） */
  score: number;
  level: RelatedLevel;
  /** 命中的共有产品名片段（去重、按长度降序，最多 5 个） */
  shared: string[];
  /** 中文一句话，如「标题/包内文件共有「真実の穴」」 */
  reason: string;
  assetCount: number;
  imageCount: number;
}
export interface ItemRelatedResponse {
  itemId: number;
  min: number;
  matches: RelatedMatch[];
}


// ---------------- 工程"实际引用"（/api/items/:id/usage、/api/projects/:id/*usage） ----------------
/**
 * 某个工程里**真的在用**这个条目的哪些文件。
 * 与 project_imports（"登记导入"）不是一回事：这里由 project_refs 的 GUID 求交得到，
 * 没有扫描数据时 projects 为空数组（不是错误）。
 */
export interface ProjectRefUsage {
  projectId: number;
  name: string;
  path: string;
  /** 命中的文件数 */
  files: number;
  /** 命中的路径（最多 20 条，按 path 排序） */
  paths: string[];
}
export interface ItemUsageResponse {
  itemId: number;
  projects: ProjectRefUsage[];
}
/** GET /projects/:id/usage 里的一条：这个工程真的用到了哪个条目。 */
export interface ProjectUsageItem {
  itemId: number;
  title: string;
  files: number;
  paths: string[];
}
export interface ProjectUsageResponse {
  projectId: number;
  name: string;
  items: ProjectUsageItem[];
}
/** POST /projects/:id/scan-usage 的结果（扫描可能跑几十秒，remaining=true 表示预算用尽还有资产没查）。 */
export interface ScanUsageResponse {
  projectId: number;
  scannedFiles: number;
  guidCount: number;
  matchedGuids: number;
  matchedItems: number;
  matchedAssets: number;
  truncated: boolean;
  remaining: boolean;
  ms: number;
}

// ---------------- Avatar 素材工作台（task-39） ----------------
/**
 * 证据级别（后端 asset_units.avatar_json[].level，前端只做展示映射，未知值原样显示不吞）：
 *   confirmed 人工确认 > probable 结构/路径推断 > unknown 未定
 *   （旧后端可能给 strong / weak / none，同样按原样兼容显示）
 */
export type WorkbenchLevel = "confirmed" | "probable" | "unknown" | "strong" | "weak" | "none" | string;
/**
 * 打包策略（后端 asset_units.policy）：
 *   single_unitypackage 独立包 / mixed_unitypackage 混合整包（导入必带其它资源）/
 *   unknown_structure 结构未知（不可导入）/（旧值 standalone / multi_package / unknown 兼容）
 */
export type WorkbenchPolicy =
  | "single_unitypackage" | "mixed_unitypackage" | "unknown_structure"
  | "standalone" | "multi_package" | "mixed" | "unknown" | string;

export interface WorkbenchAvatarCounts {
  total: number;
  /** 已确认 */
  confirmed: number;
  /** 结构/路径推断（后端 counts.probable） */
  probable: number;
  /** 未定 */
  unknown: number;
  /** 混合整包单元数 */
  mixed: number;
  /** 兼容旧后端的 suggested 计数 */
  suggested?: number;
  /** 其它后端计数（如 byPolicy）；展示时按 key 兜底 */
  [k: string]: number | undefined;
}
export interface WorkbenchAvatar {
  id: number;
  name: string;
  kind: string | null;
  owned: number;
  coverPath: string | null;
  counts: WorkbenchAvatarCounts;
}

export interface WorkbenchEvidence {
  level: WorkbenchLevel;
  /** 一句话摘要（后端给的原文，前端不重新拼） */
  summary: string;
  /** 证据来源（title / archive_path / unitypackage_path / ...） */
  sources: string[];
}

/**
 * 工作台里的一条「素材单元」= 一个可导入的包/文件（挂在某个 item 下）。
 * unitId 缺失时由前端用 assetId/itemId/relPath 兜底生成，保证列表 key 与勾选稳定。
 */
export interface WorkbenchItem {
  unitId: string;
  itemId: number;
  assetId: number | null;
  title: string;
  sourceSite: string | null;
  sourceItemId: string | null;
  shopName: string | null;
  coverImageId: number | null;
  /** 包名（zip / .unitypackage 文件名） */
  packageName: string | null;
  /** 包内相对路径 */
  relPath: string | null;
  /** 容器路径（同一个压缩包里的多个单元共享它）——导入清单按它做互斥 */
  containerPath: string | null;
  avatarId: number | null;
  avatarName: string | null;
  kind: string | null;
  level: WorkbenchLevel;
  evidence: WorkbenchEvidence | null;
  policy: WorkbenchPolicy;
  /** 整包风险：true = 导入这个单元会把整包里其它 Avatar 的资源也带进来 */
  mixed: boolean;
  /** 后端 importable：只有 single_unitypackage / mixed_unitypackage 为 true */
  importable: boolean;
  /** 单元解析状态：ok / partial / failed（非 ok 时 policy 会落 unknown_structure） */
  parseState: string | null;
  suggested: boolean;
  confirmed: boolean;
  error: { code: string; message: string } | null;
}

/** GET /api/workbench/units 的查询参数（后端只认这几个；q/category 由前端本地筛）。 */
export interface WorkbenchItemQuery {
  itemId?: number;
  avatarId?: number;
  q?: string;
  category?: string;
  level?: string;
  policy?: string;
  itemStatus?: string;
  confirmedOnly?: boolean;
  limit?: number;
}
export interface WorkbenchItemsResponse {
  items: WorkbenchItem[];
  total: number;
}

/** 计划单元：来自 WorkbenchItem，但只保留计划需要的字段。 */
export interface ImportPlanUnit {
  unitId: string;
  itemId: number;
  assetId: number | null;
  title: string;
  packagePath: string | null;
  policy: WorkbenchPolicy;
  mixed: boolean;
  suggested: boolean;
  /** 后端计划项状态：suggested（建议，需用户勾选）/ pending（待执行）/ … 原样透传 */
  state: string;
  error: { code: string; message: string } | null;
}
export interface ImportPrecheck {
  ok: boolean;
  status: string;
  warnings: string[];
  errors: { code: string; message: string }[];
}
export interface ImportPlan {
  id: number;
  state: string;
  avatarId: number | null;
  avatarName: string | null;
  projectPath: string | null;
  projectName: string | null;
  precheck: ImportPrecheck;
  units: ImportPlanUnit[];
  /** 后端若给整包风险文案就用它；没给时前端用 MIXED_WARNING 常量 */
  mixedWarning: string | null;
  runId: number | null;
  /** 提交执行后后端返回的顶层作业 id（task-42：execute 变成 Job 化，202 {jobId, planId}） */
  jobId: number | null;
  createdAt: string | null;
  error: { code: string; message: string } | null;
}

/**
 * POST /api/import-plans/:id/confirm —— 202 { jobId, planId }（task-42 Job 化）。
 * **不要假设同步返回 run**：runId 可能为 null，稍后由 GET /api/import-plans/:id 给出 run_id。
 */
export interface ImportExecuteAck {
  jobId: number | null;
  planId: number;
  runId: number | null;
}

/**
 * 执行单元状态（后端契约，原样展示，**前端不新增状态、不推断转移**）：
 * planned → importing → import_command_completed → verifying → verified
 * 失败分支：partial_success / failed；无法判定：unknown
 */
export type ImportUnitState =
  | "planned" | "importing" | "import_command_completed" | "verifying"
  | "verified" | "partial_success" | "failed" | "unknown" | string;

export interface ImportRunUnit {
  unitId: string;
  itemId: number;
  title: string;
  state: ImportUnitState;
  error: { code: string; message: string } | null;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface ImportRun {
  id: number;
  planId: number;
  state: string;
  units: ImportRunUnit[];
  error: { code: string; message: string } | null;
  startedAt: string | null;
  finishedAt: string | null;
}

