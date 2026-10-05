/**
 * Web 侧 API 形状 —— 严格按 docs/api.md (FROZEN v1) + packages/core/src/contracts.ts
 * 契约类型从 @core/contracts 只读复用，不重新定义字段名。
 */
import type {
  ArchiveEntry, AssetAvatarRow, AssetRow, AvatarAliasRow, AvatarKind, AvatarMatch,
  BoothItemMeta, ContainerKind, ImageRow, ItemCard, ItemRow, ItemStatus, JobEventRow,
  JobRow, LibraryRootRow, SourceSite, TagRow, UnityPackageAsset, UpdateKind,
} from "@core/contracts";

export type {
  ArchiveEntry, AssetAvatarRow, AssetRow, AvatarAliasRow, AvatarKind, AvatarMatch,
  BoothItemMeta, ContainerKind, ImageRow, ItemRow, ItemStatus, JobEventRow, JobRow,
  LibraryRootRow, SourceSite, TagRow, UnityPackageAsset, UpdateKind,
};

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
  sort?: "updated" | "title" | "size";
  limit?: number;
  offset?: number;
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
