/**
 * AssetVault 共享契约（FROZEN — lead 所有；其他人只读，需要变更先找 lead）
 * 对应已校验模型：SM hash 0e6eeaf667e374349aa0da5839c8bd0ed53d4577ee81516063681604648aef02
 *                  DM hash 6a641bc318908424cf2bcdf6a7d377bc4f7e01ce1e55745976d4f64508b52295
 */

// ---------- 枚举 ----------
export type SourceSite = "booth" | "gumroad" | "unity_asset_store" | "itch" | "other" | "local";
export type ItemStatus = "inbox" | "active" | "archived" | "trashed";
export type ImageRole = "cover" | "gallery" | "package_preview" | "archive_frame" | "user";
export type ImageOrigin = "booth" | "archive" | "generated" | "user";
export type AssetKind = "archive" | "unitypackage" | "folder" | "loose_file" | "image_set";
export type ContainerKind = "zip" | "7z" | "rar" | "unitypackage" | "dir" | "file";
export type AssetStatus = "present" | "missing" | "trashed";
export type ShaState = "pending" | "ok" | "error";
export type AvatarKind = "avatar" | "base" | "part" | "unknown";
export type AvatarMatch = "any" | "all" | "exclude";
export type AvatarEvidenceSource =
  | "title" | "booth_tag" | "description" | "archive_path" | "unitypackage_path"
  | "filename" | "declared_count" | "manual";
export type JobState =
  | "queued" | "resolving" | "fetching" | "materializing" | "indexing" | "matching"
  | "releasing" | "releasing_done" | "paused" | "done" | "failed" | "cancelled" | "abandoned";
export type JobKind = "import_url" | "import_file" | "scan" | "reindex" | "check_update" | "download" | "match_avatars";
export type JobEvent =
  | "start" | "resolve_ok" | "fetch_ok" | "commit" | "index_ok" | "match_ok" | "stop"
  | "fail" | "hold" | "cancel_apply" | "give_up" | "succeed" | "resume" | "retry" | "abandon";
export type StopReason = "fail" | "hold" | "cancel" | "give_up" | "succeed";
export type RootMode = "index_in_place" | "managed";
export type UpdateKind = "new_file" | "file_changed" | "price_changed" | "image_changed";

// ---------- 状态机（v9，校验 0 error）----------
export const TERMINAL_STATES: readonly JobState[] = ["done", "cancelled", "abandoned"];
export const IN_FLIGHT_STATES: readonly JobState[] = ["queued", "resolving", "fetching", "materializing", "indexing", "matching", "releasing", "releasing_done", "paused"];
export const MAX_ATTEMPTS = 5;

/** 转移表：from+event -> to。未列出的 (state,event) 一律拒绝（409），绝不静默忽略。 */
export const TRANSITIONS: ReadonlyArray<{ from: JobState; event: JobEvent; to: JobState; guard?: (ctx: { attempts: number }) => boolean }> = [
  { from: "queued", event: "start", to: "resolving" },
  { from: "queued", event: "stop", to: "releasing" },
  { from: "resolving", event: "resolve_ok", to: "fetching" },
  { from: "resolving", event: "stop", to: "releasing" },
  { from: "fetching", event: "fetch_ok", to: "materializing" },
  { from: "fetching", event: "stop", to: "releasing" },
  { from: "materializing", event: "commit", to: "indexing" },
  { from: "materializing", event: "stop", to: "releasing" },
  { from: "indexing", event: "index_ok", to: "matching" },
  { from: "indexing", event: "stop", to: "releasing" },
  { from: "matching", event: "match_ok", to: "releasing_done" },
  { from: "matching", event: "stop", to: "releasing" },
  { from: "releasing", event: "fail", to: "failed" },
  { from: "releasing", event: "hold", to: "paused" },
  { from: "releasing", event: "cancel_apply", to: "cancelled" },
  { from: "releasing", event: "give_up", to: "abandoned" },
  { from: "releasing_done", event: "succeed", to: "done" },
  { from: "paused", event: "resume", to: "queued" },
  { from: "failed", event: "retry", to: "queued", guard: (c) => c.attempts < MAX_ATTEMPTS },
  { from: "failed", event: "retry", to: "abandoned" }, // 默认分支：次数用尽时退化为放弃
  { from: "failed", event: "abandon", to: "abandoned" },
];

/** 解析一次转移；未定义 → null（调用方必须回 409 并记 job_events，不得静默忽略）。 */
export function resolveTransition(state: JobState, event: JobEvent, ctx: { attempts: number }): JobState | null {
  const group = TRANSITIONS.filter((t) => t.from === state && t.event === event);
  if (group.length === 0) return null;
  const guarded = group.find((t) => t.guard);
  if (guarded) return guarded.guard!(ctx) ? guarded.to : (group.find((t) => !t.guard)?.to ?? null);
  return group[0]?.to ?? null;
}

// ---------- BOOTH provider ----------
export interface BoothImage { original: string; resized?: string; caption?: string | null }
export interface BoothDownloadableFile { name: string; file_name?: string; file_extension?: string; file_size?: string; url: string }
export interface BoothVariation { id: number; price: number; name?: string | null; files: BoothDownloadableFile[] }
export interface BoothShop { name: string; subdomain: string }
export interface BoothTag { name: string; url?: string }
export interface BoothCategory { id?: number; name: string; parent?: { name: string } | null }
export interface BoothItemMeta {
  itemId: string;
  title: string;
  description: string;
  priceText: string | null;
  priceYen: number | null;
  publishedAt: string | null;
  isAdult: boolean;
  url: string;
  shop: BoothShop | null;
  tags: BoothTag[];
  category: BoothCategory | null;
  images: BoothImage[];
  variations: BoothVariation[];
  raw?: unknown;
}
export interface BoothFetchOptions { userAgent?: string; timeoutMs?: number; proxyUrl?: string; adultCookie?: boolean; minIntervalMs?: number }

// ---------- 识别（商品号）----------
export interface IdentifyCandidate { itemId: string; confidence: number; method: "url" | "filename" | "downloadable_name" | "manual"; evidence: string[] }
export interface IdentifyResult { candidates: IdentifyCandidate[]; best: IdentifyCandidate | null }

// ---------- 头像 ----------
export interface AvatarHit { name: string; confidence: number; sources: AvatarEvidenceSource[]; evidence: string[] }
export interface AvatarDetectionInput {
  title?: string | null;
  description?: string | null;
  tags?: string[] | null;
  fileNames?: string[] | null;
  archivePaths?: string[] | null;
  unitypackagePaths?: string[] | null;
}
export interface AvatarDetectionResult { hits: AvatarHit[]; declaredCount: number | null; planned: string[] }
export interface KnownAvatar { name: string; aliases: string[]; kind: AvatarKind }

// ---------- 压缩包 / unitypackage ----------
export interface ArchiveEntry { path: string; size: number; isDir: boolean; crc?: number | null }
export interface ArchiveListing { container: ContainerKind; entries: ArchiveEntry[]; truncated: boolean; passwordProtected: boolean; note?: string }
export interface UnityPackageAsset { guid: string; assetPath: string; type: string | null; size: number | null; hasPreview: boolean }
export interface UnityPackageListing { assets: UnityPackageAsset[]; truncated: boolean }

// ---------- 数据库行 ----------
export interface ItemRow {
  id: number; uid: string; source_site: SourceSite; source_item_id: string | null; source_url: string | null;
  canonical_url: string | null; title: string; title_ja: string | null; shop_name: string | null; shop_subdomain: string | null;
  author: string | null; price_text: string | null; price_yen: number | null; purchased: number; purchased_at: string | null;
  published_at: string | null; category_name: string | null; category_parent: string | null; description: string | null;
  adult: number; status: ItemStatus; rating: number | null; favorite: number; notes: string | null;
  cover_image_id: number | null; compat_declared_count: number | null; id_confidence: number | null;
  id_match_method: string | null; source_gone: number; last_checked_at: string | null; created_at: string; updated_at: string;
}
export interface ImageRow {
  id: number; item_id: number; role: ImageRole; origin: ImageOrigin; source_url: string | null; file_path: string | null;
  thumb_path: string | null; width: number | null; height: number | null; bytes: number | null; sha256: string | null;
  position: number; created_at: string;
}
export interface AssetRow {
  id: number; item_id: number; kind: AssetKind; container: ContainerKind; path: string; path_norm: string; root_id: number;
  size: number; mtime: string | null; sha256: string | null; sha256_state: ShaState; status: AssetStatus;
  discovered_by: "scan" | "watch" | "download" | "manual"; first_seen: string; last_verified_at: string | null;
}
export interface AvatarRow { id: number; name: string; name_norm: string; kind: AvatarKind; booth_item_id: string | null; cover_path: string | null; owned: number; sort: number; created_at: string; updated_at: string }
export interface AvatarAliasRow { id: number; avatar_id: number; alias: string; alias_norm: string; lang: string | null; source: "booth_tag" | "filename" | "user" | "seed" }
export interface ItemAvatarRow { item_id: number; avatar_id: number; match: AvatarMatch; confidence: number; evidence: string | null; source: "auto" | "manual" | "confirmed" }
export interface AssetAvatarRow { id: number; asset_id: number; avatar_id: number; entry_prefix: string | null; confidence: number; evidence: string | null }
export interface TagRow { id: number; name: string; namespace: string | null; color: string | null; sort: number }
export interface JobRow {
  id: number; kind: JobKind; item_id: number | null; payload: string | null; state: JobState; attempts: number;
  priority: number; error: string | null; created_at: string; started_at: string | null; finished_at: string | null;
}
export interface JobEventRow { id: number; job_id: number; at: string; from_state: JobState | null; to_state: JobState; event: string; detail: string | null }
export interface LibraryRootRow { id: number; path: string; path_norm: string; mode: RootMode; enabled: number; created_at: string }

// ---------- API 形状 ----------
export interface ItemCard {
  id: number; title: string; sourceSite: SourceSite; sourceItemId: string | null; sourceUrl: string | null;
  shopName: string | null; status: ItemStatus; favorite: number; adult: number;
  coverImageId: number | null; coverUrl: string | null; imageCount: number; assetCount: number; totalBytes: number;
  avatars: { id: number; name: string; match: AvatarMatch }[]; tags: string[]; compatDeclaredCount: number | null;
  /** 所属套装（collection）名称，用于卡片徽章与筛选展示 */
  collections?: { id: number; name: string }[];
  updatedAt: string;
}
export interface ItemDetail extends ItemCard { item: ItemRow; images: ImageRow[]; assets: AssetRow[]; notes: string | null; description: string | null; collections?: { id: number; name: string }[] }

// ---------- 错误 ----------
export type AppErrorCode =
  | "NOT_FOUND" | "INVALID_INPUT" | "CONFLICT" | "INVALID_TRANSITION" | "UPSTREAM_ERROR"
  | "LOGIN_REQUIRED" | "NOT_AN_ARCHIVE" | "ARCHIVE_PASSWORD" | "READ_ONLY_SCOPE";
export class AppError extends Error {
  constructor(public code: AppErrorCode, message: string, public status = 400) { super(message); this.name = "AppError"; }
}


// ---------- 规范键（全项目唯一实现：别名/名称归一都走这里）----------
const PUNCT = /[\s\u3000·・.,，、。!！?？'"“”‘’()（）\[\]【】<>《》_\-—–~〜:：;；/\\|+＋&＆*＊#＃]/g;
/** NFKC + 小写 + 去空白与标点。normAlias 必须与本函数结果一致（可在其上再做幂等折叠）。 */
export function normKey(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(PUNCT, "");
}
