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
}
export interface UnityPackageResponse {
  assets: UnityPackageAsset[];
  truncated?: boolean;
  /** 服务端已算好的总数/类型统计（实测返回 {assets,total,byType}），缺失时前端自行统计 */
  total?: number;
  byType?: Record<string, number>;
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
