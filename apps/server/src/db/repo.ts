import type Database from "better-sqlite3";
import { now, uid, ftsPhrase } from "../util";
import { normalizePath } from "../../../../packages/core/src/pathnorm";
import { normKey, type AssetRow, type AvatarAliasRow, type AvatarKind, type AvatarMatch, type AvatarRow, type CategoryAssignment, type CategoryNode, type CategoryRefSource, type CategorySuggestion, type ImageOrigin, type ImageRole, type ImageRow, type ItemCard, type ItemDetail, type ItemRow, type ItemStatus, type JobEvent, type JobKind, type JobRow, type JobState, type RootMode, type SourceSite, type UpdateKind } from "../../../../packages/core/src/contracts";
import { UNCATEGORIZED_ID, type CategoryDef } from "../../../../packages/core/src/categories/taxonomy";
import { resolveTransition } from "../../../../packages/core/src/contracts";

export interface ItemQuery {
  q?: string; avatarIds?: number[]; avatarMatch?: "any" | "all"; ownedOnly?: boolean;
  site?: string; status?: string; tag?: string; container?: string;
  sort?: "updated" | "title" | "size"; limit?: number; offset?: number; includeTrashed?: boolean; imported?: boolean; collectionId?: number;
  /** 分类筛选：选中主分类命中其自身，选中子分类命中子分类（any=命中任一；all=路径需同时满足选中的每个节点） */
  categoryIds?: string[]; categoryMatch?: "any" | "all";
  /** 只看未分类（cat_id IS NULL） */
  uncategorized?: boolean;
  /** 只看有自动推荐待确认的条目 */
  pendingCategory?: boolean;
  /** 标签多选（与 avatar 的 ANY/ALL 同语义）；旧的单个 tag= 仍兼容 */
  tagNames?: string[]; tagMatch?: "any" | "all";
  /** 收藏 */
  favoriteOnly?: boolean;
}
export interface AvatarCard extends AvatarRow { itemCount: number; aliases: string[]; ownedBool: boolean }
export interface StatsShape {
  items: number; assets: number; bytes: number; avatars: number; inbox: number; missing: number;
  byCategory: { name: string; count: number }[]; byAvatar: { id: number; name: string; count: number }[];
}

/** v6 租约：jobs 行上的辅助元数据（不改变作业状态机，job.state 仍是唯一状态机）。 */
export interface JobLease { holder: string; token: number }
/**
 * v0.6.1 FIX-07：派生写入（assets/items/scan_assets）的作业围栏。
 * 只有 jobs 行仍是该 jobId + holder + lease_token 时才允许写；接管后旧持有者的写入 0 行。
 * 不传 fence 的调用（HTTP/用户操作、pipeline 派生）保持旧行为。
 */
export interface JobFence { jobId: number; holder: string; token: number }
export interface JobWithLease extends JobRow {
  holder: string | null;
  lease_until: string | null;
  lease_token: number;
  heartbeat_at: string | null;
}
/** 默认租约 60s / 心跳 15s（JobRunner 可用 env ASSETVAULT_JOB_LEASE_MS / _HEARTBEAT_MS 覆盖）。 */
export const DEFAULT_JOB_LEASE_MS = 60_000;
export const DEFAULT_JOB_HEARTBEAT_MS = 15_000;
/** 租约竞争失败（旧持有者的迟到写入 / 续租失败 / 被用户暂停或接管）→ 409，且**不写事件**。 */
export class LeaseLostError extends Error {
  readonly code = "LEASE_LOST";
  readonly status = 409;
  constructor(message: string) { super(message); this.name = "LeaseLostError"; }
}

// ---------- 事件保留（v0.6.1 task-13；双上限 + terminal-only + 有界批次） ----------
export interface EventRetentionConfig {
  /** job_events 保留天数（0=不按时间删）。 */
  jobDays: number;
  /** job_events 条数上限（0=不限）；只从"可删集合"里删。 */
  jobMaxRows: number;
  pipelineDays: number;
  pipelineMaxRows: number;
  /** 单批删除上限（clamp 1..500，约束长事务）。 */
  batchSize: number;
  /** discovery_throttled 合并窗口（0=不合并）；同 job_id + event 才合并。 */
  coalesceWindowMs: number;
}
export const DEFAULT_EVENT_RETENTION: Readonly<EventRetentionConfig> = {
  jobDays: 30, jobMaxRows: 100_000,
  pipelineDays: 14, pipelineMaxRows: 200_000,
  batchSize: 200, coalesceWindowMs: 60_000,
};
export interface EventRetentionState {
  at: string;
  deletedJobEvents: number;
  deletedPipelineEvents: number;
  batches: number;
  error: string | null;
  consecutiveFailures: number;
  /** 可删集合已空但仍超条数上限：拒绝为达标而删受保护事件（保护优先）。 */
  blocked: { job: boolean; pipeline: boolean };
}
/** 配置归一化/夹紧（缺省、非法、越界一律收敛到安全值；batchSize ≤500）。 */
export function normalizeEventRetention(raw: unknown): EventRetentionConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, def: number, min: number, max: number): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.floor(n)));
  };
  return {
    jobDays: num(o.jobDays, DEFAULT_EVENT_RETENTION.jobDays, 0, 3650),
    jobMaxRows: num(o.jobMaxRows, DEFAULT_EVENT_RETENTION.jobMaxRows, 0, 10_000_000),
    pipelineDays: num(o.pipelineDays, DEFAULT_EVENT_RETENTION.pipelineDays, 0, 3650),
    pipelineMaxRows: num(o.pipelineMaxRows, DEFAULT_EVENT_RETENTION.pipelineMaxRows, 0, 10_000_000),
    batchSize: num(o.batchSize, DEFAULT_EVENT_RETENTION.batchSize, 1, 500),
    coalesceWindowMs: num(o.coalesceWindowMs, DEFAULT_EVENT_RETENTION.coalesceWindowMs, 0, 24 * 3600_000),
  };
}

/** 在飞（可被过期回收）的状态集合；paused 是用户显式暂停，绝不自动回收。 */
const LEASABLE_JOB_STATES = "'resolving','fetching','materializing','indexing','matching','releasing','releasing_done'";
/** FIX-07：围栏子句（追加在 WHERE 后，参数由调用方按 jobId/holder/token 顺序补）。 */
const JOB_FENCE_SQL = " AND EXISTS (SELECT 1 FROM jobs j WHERE j.id=? AND j.holder=? AND j.lease_token=?)";
/** 仍在飞/可恢复的 job 状态（预览清扫时据此保护；paused 由用户持有，不判死）。 */
const ACTIVE_JOB_STATES_SQL = "'queued','resolving','fetching','materializing','indexing','matching','releasing','releasing_done','paused'";
/** pipeline_events 的删除保护：本任务不在飞，且该资产名下也没有任何在飞任务。 */
const PRUNEVENT_PROTECT =
  "NOT EXISTS (SELECT 1 FROM index_tasks t WHERE t.id=e.task_id AND t.state IN ('queued','running','waiting_retry')) " +
  "AND NOT EXISTS (SELECT 1 FROM index_tasks t2 WHERE t2.asset_id=e.asset_id AND t2.state IN ('queued','running','waiting_retry'))";
const leaseUntilOf = (atIso: string, leaseMs: number): string => new Date(Date.parse(atIso) + Math.max(1, leaseMs)).toISOString();

export class Repo {
  /** 预编译语句缓存：热路径（claim/finish/syncFts/transition）每次 prepare 实测占索引 CPU 的 ~20%。 */
  private stmtCache = new Map<string, any>();
  private returningSupported: boolean | null = null;
  constructor(private db: Database.Database, opts: { disableReturning?: boolean } = {}) {
    if (opts.disableReturning) this.returningSupported = false;
  }

  /**
   * 有界 LRU 语句缓存（v0.6.1 task-17）：动态 SQL（IN 列表/可变 SET）会生成不同文本，缓存必须封顶。
   * 命中即刷新顺序；超限淘汰最久未用。上限 256 足以覆盖热路径，又不会随调用次数无界增长。
   */
  private stmt(sql: string): any {
    const hit = this.stmtCache.get(sql);
    if (hit) { this.stmtCache.delete(sql); this.stmtCache.set(sql, hit); return hit; }
    const s = this.db.prepare(sql);
    this.stmtCache.set(sql, s);
    if (this.stmtCache.size > Repo.STMT_CACHE_MAX) {
      const oldest = this.stmtCache.keys().next().value;
      if (oldest !== undefined) this.stmtCache.delete(oldest);
    }
    return s;
  }
  /** 测试/诊断用：当前缓存条目数（必须 ≤ STMT_CACHE_MAX）。 */
  stmtCacheSize(): number { return this.stmtCache.size; }
  private static readonly STMT_CACHE_MAX = 256;
  /** 固定分块大小（IN 列表/多行 VALUES 一律补到该长度，保证 SQL 文本形状固定）。 */
  private static readonly BATCH_CHUNK = 400;

  // ---------- roots ----------
  listRoots() { return this.stmt("SELECT * FROM library_roots ORDER BY id").all(); }
  getRootByPathNorm(p: string) { return this.stmt("SELECT * FROM library_roots WHERE path_norm = ?").get(p) as any; }
  ensureRoot(path: string, mode: RootMode = "index_in_place") {
    const pn = normalizePath(path);
    const existing = this.getRootByPathNorm(pn);
    if (existing) return existing;
    const info = this.stmt("INSERT INTO library_roots(path, path_norm, mode, enabled, created_at) VALUES (?,?,?,1,?)").run(path, pn, mode, now());
    return this.stmt("SELECT * FROM library_roots WHERE id = ?").get(info.lastInsertRowid) as any;
  }
  removeRoot(id: number) { this.stmt("DELETE FROM library_roots WHERE id = ?").run(id); }

  // ---------- items ----------
  private buildWhere(q: ItemQuery): { sql: string; params: unknown[] } {
    const w: string[] = []; const params: unknown[] = [];
    if (!q.includeTrashed && q.status !== "trashed") w.push("i.status <> 'trashed'");
    if (q.status) { w.push("i.status = ?"); params.push(q.status); }
    if (q.site) { w.push("i.source_site = ?"); params.push(q.site); }
    const text = (q.q ?? "").trim();
    if (text) {
      if (text.length >= 3) { w.push("i.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)"); params.push(ftsPhrase(text)); }
      else {
        // <3 字符（trigram 索引不了）回退 LIKE，且**标签也参与匹配**：
        // 用户的心智是"搜什么就找什么"，不该为了找一个 2 字标签再去开单独筛选。
        const l = `%${text}%`;
        w.push("(i.title LIKE ? OR IFNULL(i.shop_name,'') LIKE ? OR IFNULL(i.author,'') LIKE ? OR IFNULL(i.notes,'') LIKE ?" +
          " OR EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=i.id AND t.name LIKE ?))");
        params.push(l, l, l, l, l);
      }
    }
    if (q.tag) { w.push("EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=i.id AND t.name = ?)"); params.push(q.tag); }
    if (q.container) { w.push("EXISTS (SELECT 1 FROM assets a WHERE a.item_id=i.id AND a.status<>'trashed' AND a.container = ?)"); params.push(q.container); }
    if (q.ownedOnly) w.push("EXISTS (SELECT 1 FROM item_avatars ia JOIN avatars av ON av.id=ia.avatar_id WHERE ia.item_id=i.id AND av.owned=1)");
    if (q.collectionId) { w.push("EXISTS (SELECT 1 FROM collection_items ci WHERE ci.item_id=i.id AND ci.collection_id = ?)"); params.push(q.collectionId); }
    if (q.imported === true) w.push("EXISTS (SELECT 1 FROM project_imports pi WHERE pi.item_id=i.id)");
    if (q.imported === false) w.push("NOT EXISTS (SELECT 1 FROM project_imports pi WHERE pi.item_id=i.id)");
    const ids = (q.avatarIds ?? []).filter((n) => Number.isFinite(n));
    if (ids.length > 0) {
      const ph = ids.map(() => "?").join(",");
      if ((q.avatarMatch ?? "any") === "all") {
        w.push(`(SELECT COUNT(DISTINCT ia.avatar_id) FROM item_avatars ia WHERE ia.item_id=i.id AND ia.match<>'exclude' AND ia.avatar_id IN (${ph})) = ${ids.length}`);
        params.push(...ids);
      } else {
        w.push(`EXISTS (SELECT 1 FROM item_avatars ia WHERE ia.item_id=i.id AND ia.match<>'exclude' AND ia.avatar_id IN (${ph}))`);
        params.push(...ids);
      }
    }
    // 分类筛选：ANY=命中任一节点；ALL=条目分类路径必须包含每一个选中节点
    // （一个条目只有 主分类+子分类，所以 ALL 的现实语义就是"同时选中某父与其子"→ 精确到那一对）
    const catIds = (q.categoryIds ?? []).map((s) => String(s).trim()).filter(Boolean);
    if (catIds.length > 0) {
      if ((q.categoryMatch ?? "any") === "all") {
        for (const cid of catIds) { w.push("(i.cat_id = ? OR i.cat_sub_id = ?)"); params.push(cid, cid); }
      } else {
        const ph = catIds.map(() => "?").join(",");
        w.push(`(i.cat_id IN (${ph}) OR i.cat_sub_id IN (${ph}))`);
        params.push(...catIds, ...catIds);
      }
    }
    // 未分类 = cat_id 为空 **或** 指向系统分类「未分类」（v3）；两者是同一集合
    if (q.uncategorized) w.push("(i.cat_id IS NULL OR i.cat_id = 'uncategorized')");
    const tagNames = (q.tagNames ?? []).map((s) => String(s).trim()).filter(Boolean);
    if (tagNames.length > 0) {
      const ph = tagNames.map(() => "?").join(",");
      if ((q.tagMatch ?? "any") === "all") {
        w.push(`(SELECT COUNT(DISTINCT t.name) FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=i.id AND t.name IN (${ph})) = ${tagNames.length}`);
      } else {
        w.push(`EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=i.id AND t.name IN (${ph}))`);
      }
      params.push(...tagNames);
    }
    if (q.favoriteOnly) w.push("i.favorite = 1");
    if (q.pendingCategory) w.push("i.cat_suggest_id IS NOT NULL");
    return { sql: w.length ? " WHERE " + w.join(" AND ") : "", params };
  }

  private toCard(r: any, avatars: { id: number; name: string; match: AvatarMatch }[], tags: string[]): ItemCard {
    return {
      id: r.id, title: r.title, sourceSite: r.source_site, sourceItemId: r.source_item_id, sourceUrl: r.source_url,
      shopName: r.shop_name, status: r.status, favorite: r.favorite, adult: r.adult,
      // 没显式设封面时用第一张图兜底，否则卡片在列表页会显示"无图"（悬停才加载）
      coverImageId: r.cover_image_id ?? r.first_image_id ?? null,
      coverUrl: (r.cover_image_id ?? r.first_image_id) ? `/api/media/${r.cover_image_id ?? r.first_image_id}?w=480` : null,
      imageCount: r.image_count ?? 0, assetCount: r.asset_count ?? 0, totalBytes: r.total_bytes ?? 0,
      avatars, tags, compatDeclaredCount: r.compat_declared_count ?? null, updatedAt: r.updated_at,
      collections: r.collection_names ? String(r.collection_names).split("\u001f").map((p) => { const [id, name] = p.split("\u001e"); return { id: Number(id), name: String(name) }; }) : [],
      category: this.categoryAssignment(r),
      suggestion: this.categorySuggestion(r),
    };
  }

  listItems(q: ItemQuery): { total: number; items: ItemCard[] } {
    const { sql: where, params } = this.buildWhere(q);
    const limit = Math.min(500, Math.max(1, q.limit ?? 60));
    const offset = Math.max(0, q.offset ?? 0);
    // 分页稳定性：排序键必须带唯一兜底列（id）。扫描产生的条目 updated_at 常落在同一毫秒，
    // 只按 updated_at 排序时 SQLite 的行序不保证稳定 → 翻页会重复或漏项。
    const order = q.sort === "title" ? "i.title COLLATE NOCASE ASC, i.id ASC"
      : q.sort === "size" ? "total_bytes DESC, i.id DESC"
      : "i.updated_at DESC, i.id DESC";
    const total = (this.stmt(`SELECT COUNT(*) c FROM items i${where}`).get(...params as any[]) as any).c as number;
    const rows = this.stmt(`
      SELECT i.*,
        (SELECT COUNT(*) FROM item_images im WHERE im.item_id=i.id) AS image_count,
        (SELECT id FROM item_images im2 WHERE im2.item_id=i.id ORDER BY im2.position, im2.id LIMIT 1) AS first_image_id,
        (SELECT COUNT(*) FROM assets a WHERE a.item_id=i.id AND a.status<>'trashed') AS asset_count,
        (SELECT COALESCE(SUM(a.size),0) FROM assets a WHERE a.item_id=i.id AND a.status<>'trashed') AS total_bytes,
        (SELECT GROUP_CONCAT(c.id || char(30) || c.name, char(31)) FROM collection_items ci JOIN collections c ON c.id=ci.collection_id WHERE ci.item_id=i.id) AS collection_names
      FROM items i${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params as any[], limit, offset) as any[];
    const idsList = rows.map((r) => r.id);
    const avMap = this.itemAvatarsFor(idsList);
    const tagMap = this.itemTagsFor(idsList);
    return { total, items: rows.map((r) => this.toCard(r, avMap.get(r.id) ?? [], tagMap.get(r.id) ?? [])) };
  }

  private itemAvatarsFor(ids: number[]): Map<number, { id: number; name: string; match: AvatarMatch }[]> {
    const m = new Map<number, { id: number; name: string; match: AvatarMatch }[]>();
    if (ids.length === 0) return m;
    const ph = ids.map(() => "?").join(",");
    const rows = this.stmt(`SELECT ia.item_id, av.id, av.name, ia.match FROM item_avatars ia JOIN avatars av ON av.id=ia.avatar_id WHERE ia.item_id IN (${ph}) ORDER BY av.sort, av.name`).all(...ids) as any[];
    for (const r of rows) { const a = m.get(r.item_id) ?? []; a.push({ id: r.id, name: r.name, match: r.match }); m.set(r.item_id, a); }
    return m;
  }
  private itemTagsFor(ids: number[]): Map<number, string[]> {
    const m = new Map<number, string[]>();
    if (ids.length === 0) return m;
    const ph = ids.map(() => "?").join(",");
    const rows = this.stmt(`SELECT it.item_id, t.name, t.namespace FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id IN (${ph})`).all(...ids) as any[];
    for (const r of rows) { const a = m.get(r.item_id) ?? []; a.push(r.namespace ? `${r.namespace}:${r.name}` : r.name); m.set(r.item_id, a); }
    return m;
  }

  getItem(id: number): ItemDetail | null {
    const r = this.stmt(`SELECT i.*,
        (SELECT COUNT(*) FROM item_images im WHERE im.item_id=i.id) AS image_count,
        (SELECT id FROM item_images im2 WHERE im2.item_id=i.id ORDER BY im2.position, im2.id LIMIT 1) AS first_image_id,
        (SELECT COUNT(*) FROM assets a WHERE a.item_id=i.id AND a.status<>'trashed') AS asset_count,
        (SELECT COALESCE(SUM(a.size),0) FROM assets a WHERE a.item_id=i.id AND a.status<>'trashed') AS total_bytes,
        (SELECT GROUP_CONCAT(c.id || char(30) || c.name, char(31)) FROM collection_items ci JOIN collections c ON c.id=ci.collection_id WHERE ci.item_id=i.id) AS collection_names
      FROM items i WHERE i.id = ?`).get(id) as any;
    if (!r) return null;
    const images = this.listImages(id);
    const assets = this.listAssets(id);
    // 详情页需要证据：card 级只给 {id,name,match}，详情级补 evidence/source/confidence
    const avatars = (this.stmt(`SELECT av.id, av.name, ia.match, ia.confidence, ia.evidence, ia.source
        FROM item_avatars ia JOIN avatars av ON av.id = ia.avatar_id WHERE ia.item_id = ? ORDER BY av.sort, av.name`).all(id) as any[])
      .map((a) => ({ id: a.id, name: a.name, match: a.match, confidence: a.confidence, evidence: a.evidence, source: a.source }));
    const tags = this.itemTagsFor([id]).get(id) ?? [];
    const card = this.toCard(r, avatars, tags);
    const collections = this.collectionsOfItem(id);
    return { ...card, item: r as ItemRow, images, assets, notes: r.notes ?? null, description: r.description ?? null, collections };
  }

  getItemBySource(site: SourceSite, sourceItemId: string): ItemRow | null {
    return (this.stmt("SELECT * FROM items WHERE source_site = ? AND source_item_id = ?").get(site, sourceItemId) as ItemRow) ?? null;
  }

  createItem(input: Partial<ItemRow> & { title: string }): ItemRow {
    const t = now();
    const info = this.stmt(`INSERT INTO items(uid, source_site, source_item_id, source_url, canonical_url, title, title_ja, shop_name, shop_subdomain,
        author, price_text, price_yen, purchased, published_at, category_name, category_parent, description, adult, status, notes,
        compat_declared_count, id_confidence, id_match_method, created_at, updated_at)
      VALUES (@uid,@source_site,@source_item_id,@source_url,@canonical_url,@title,@title_ja,@shop_name,@shop_subdomain,@author,@price_text,@price_yen,
        @purchased,@published_at,@category_name,@category_parent,@description,@adult,@status,@notes,@compat_declared_count,@id_confidence,@id_match_method,@created_at,@updated_at)`)
      .run({
        uid: input.uid ?? uid(), source_site: input.source_site ?? "local", source_item_id: input.source_item_id ?? null,
        source_url: input.source_url ?? null, canonical_url: input.canonical_url ?? null, title: input.title,
        title_ja: input.title_ja ?? null, shop_name: input.shop_name ?? null, shop_subdomain: input.shop_subdomain ?? null,
        author: input.author ?? null, price_text: input.price_text ?? null, price_yen: input.price_yen ?? null,
        purchased: input.purchased ?? 0, published_at: input.published_at ?? null, category_name: input.category_name ?? null,
        category_parent: input.category_parent ?? null, description: input.description ?? null, adult: input.adult ?? 0,
        status: input.status ?? "inbox", notes: input.notes ?? null, compat_declared_count: input.compat_declared_count ?? null,
        id_confidence: input.id_confidence ?? null, id_match_method: input.id_match_method ?? null, created_at: t, updated_at: t,
      });
    const row = this.stmt("SELECT * FROM items WHERE id = ?").get(info.lastInsertRowid) as ItemRow;
    this.syncFts(row.id);
    return row;
  }

  updateItem(id: number, patch: Record<string, unknown>, fence?: JobFence): ItemRow {
    const allowed = ["title", "title_ja", "shop_name", "shop_subdomain", "author", "price_text", "price_yen", "purchased", "published_at",
      "category_name", "category_parent", "description", "adult", "status", "rating", "favorite", "notes", "cover_image_id",
      "compat_declared_count", "id_confidence", "id_match_method", "source_url", "canonical_url", "source_item_id", "source_site", "source_gone", "last_checked_at"];
    const sets: string[] = []; const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) { if (allowed.includes(k) && v !== undefined) { sets.push(`${k} = ?`); params.push(v as any); } }
    if (sets.length === 0) return this.stmt("SELECT * FROM items WHERE id=?").get(id) as ItemRow;
    sets.push("updated_at = ?"); params.push(now(), id);
    let where = " WHERE id = ?";
    if (fence) { where += JOB_FENCE_SQL; params.push(fence.jobId, fence.holder, fence.token); }
    const changes = this.stmt(`UPDATE items SET ${sets.join(", ")}` + where).run(...params as any[]).changes;
    if (changes > 0) this.syncFts(id);
    return this.stmt("SELECT * FROM items WHERE id = ?").get(id) as ItemRow;
  }

  /** FTS 与 tags_text 同步（幂等）。 */
  syncFts(itemId: number): void {
    const r = this.stmt("SELECT title, shop_name, author, description, notes FROM items WHERE id = ?").get(itemId) as any;
    if (!r) return;
    const tags = this.itemTagsFor([itemId]).get(itemId) ?? [];
    this.stmt("DELETE FROM items_fts WHERE rowid = ?").run(itemId);
    this.stmt("INSERT INTO items_fts(rowid, title, shop_name, author, description, notes, tags_text) VALUES (?,?,?,?,?,?,?)")
      .run(itemId, r.title ?? "", r.shop_name ?? "", r.author ?? "", r.description ?? "", r.notes ?? "", tags.join(" "));
  }

  // ---------- images ----------
  listImages(itemId: number): ImageRow[] {
    return this.stmt("SELECT * FROM item_images WHERE item_id = ? ORDER BY position, id").all(itemId) as ImageRow[];
  }
  getImage(id: number): ImageRow | null { return (this.stmt("SELECT * FROM item_images WHERE id=?").get(id) as ImageRow) ?? null; }
  addImage(itemId: number, input: Partial<ImageRow> & { role: ImageRole; origin: ImageOrigin }): ImageRow {
    const pos = (this.stmt("SELECT COALESCE(MAX(position),-1)+1 p FROM item_images WHERE item_id=?").get(itemId) as any).p as number;
    const info = this.stmt(`INSERT INTO item_images(item_id, role, origin, source_url, file_path, thumb_path, width, height, bytes, sha256, position, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(itemId, input.role, input.origin, input.source_url ?? null, input.file_path ?? null,
      input.thumb_path ?? null, input.width ?? null, input.height ?? null, input.bytes ?? null, input.sha256 ?? null, input.position ?? pos, now());
    const img = this.stmt("SELECT * FROM item_images WHERE id=?").get(info.lastInsertRowid) as ImageRow;
    const hasCover = (this.stmt("SELECT cover_image_id FROM items WHERE id=?").get(itemId) as any)?.cover_image_id ?? null;
    if (input.role === "cover" || hasCover === null) this.setCover(itemId, img.id);
    return img;
  }
  deleteImage(itemId: number, imageId: number): void {
    // FIX-08：删除前清掉**所有**指向该图的封面引用（不只当前 item）。
    // 合并条目会把图片迁到 target，而历史脏数据可能让别的条目仍引用它；ON DELETE RESTRICT 会拒绝删除。
    this.stmt("UPDATE items SET cover_image_id = NULL WHERE cover_image_id = ?").run(imageId);
    this.stmt("DELETE FROM item_images WHERE id = ? AND item_id = ?").run(imageId, itemId);
  }
  setCover(itemId: number, imageId: number): void { this.stmt("UPDATE items SET cover_image_id=?, updated_at=? WHERE id=?").run(imageId, now(), itemId); }
  /** 历史修复：有图但 cover_image_id 为空的条目，取第一张图当封面。 */
  fixMissingCovers(): { fixed: number } {
    const rows = this.stmt(`SELECT i.id AS item_id, (SELECT id FROM item_images im WHERE im.item_id=i.id ORDER BY im.position, im.id LIMIT 1) AS img
      FROM items i WHERE i.cover_image_id IS NULL`).all() as any[];
    let fixed = 0;
    const tx = this.db.transaction(() => {
      for (const r of rows) { if (r.img) { this.stmt("UPDATE items SET cover_image_id=? WHERE id=?").run(r.img, r.item_id); fixed++; } }
    });
    tx();
    return { fixed };
  }

  // ---------- assets ----------
  listAssets(itemId: number): AssetRow[] { return this.stmt("SELECT * FROM assets WHERE item_id=? AND status<>'trashed' ORDER BY size DESC, id").all(itemId) as AssetRow[]; }
  // B1：这三处是扫描热路径（registerAssets 每个文件都走）。每次 prepare 会产生 GC 不回收的 RSS 增长
  // （实测 getAssetByPathNorm 1 万次 +141MB，registerAssets 1 万 +513MB），统一走 stmt 缓存。
  getAsset(id: number): AssetRow | null { return (this.stmt("SELECT * FROM assets WHERE id=?").get(id) as AssetRow) ?? null; }
  getAssetByPathNorm(p: string): AssetRow | null { return (this.stmt("SELECT * FROM assets WHERE path_norm=?").get(p) as AssetRow) ?? null; }
  upsertAsset(input: { item_id: number; kind: AssetRow["kind"]; container: AssetRow["container"]; path: string; path_norm: string; root_id: number; size: number; mtime?: string | null; discovered_by: AssetRow["discovered_by"] }): { asset: AssetRow; created: boolean } {
    const existing = this.getAssetByPathNorm(input.path_norm);
    if (existing) {
      // v6（F3）：同一路径 size/mtime 变了 ⇒ 旧 sha256 不再代表当前内容，必须作废。否则 contentIdentity()
      // 仍按 sha256_state='ok' 走强身份键，被陈旧哈希污染的派生缓存会被当成同一内容复用。
      // 未变化时不动 sha256/sha256_state（避免每次扫描都把已算好的哈希打成 pending）。
      const contentChanged = Number(existing.size) !== Number(input.size)
        || String(existing.mtime ?? "") !== String(input.mtime ?? "");
      this.stmt(
        "UPDATE assets SET item_id=?, size=?, mtime=?, status='present', last_verified_at=?, " +
        "sha256 = CASE WHEN ?=1 THEN NULL ELSE sha256 END, " +
        "sha256_state = CASE WHEN ?=1 THEN 'pending' ELSE sha256_state END WHERE id=?"
      ).run(input.item_id, input.size, input.mtime ?? null, now(), contentChanged ? 1 : 0, contentChanged ? 1 : 0, existing.id);
      return { asset: this.getAsset(existing.id)!, created: false };
    }
    const info = this.stmt(`INSERT INTO assets(item_id, kind, container, path, path_norm, root_id, size, mtime, sha256_state, status, discovered_by, first_seen)
      VALUES (?,?,?,?,?,?,?,?, 'pending', 'present', ?, ?)`).run(input.item_id, input.kind, input.container, input.path, input.path_norm, input.root_id, input.size, input.mtime ?? null, input.discovered_by, now());
    return { asset: this.getAsset(Number(info.lastInsertRowid))!, created: true };
  }
  /**
   * 列出某路径（含其子孙）下 status='present' 的资产。
   * M0/P1 修复旧写法 `path_norm LIKE prefix || '%'` 的两个前缀缺陷：
   *   ① 没有路径段边界：prefix="c:/lib" 会命中 "c:/library/…"、"c:/lib2/…"（同层 sibling 根互相误伤）；
   *   ② LIKE 通配符未转义：路径里的 `_` / `%` 被当通配符，prefix="c:/my_lib" 会命中 "c:/myXlib"。
   * 现在改用明确的路径段边界 + 相等，全程不经过 LIKE：
   *   [prefix + "/", prefix + "0") 恰好覆盖所有以 "prefix/" 开头的串
   *   （'/'=0x2F < '0'=0x30 ⇒ 任何 "prefix/…" 都小于 "prefix0"；不以 "prefix/" 开头的串要么小于下界、要么不小于上界）。
   * assets.path_norm 自带 UNIQUE 索引 ⇒ 该范围仍走索引扫描。
   * 正/反例对照：prefix="c:/lib" ⇒ 命中 "c:/lib/a.zip" 与 "c:/lib/sub/a.zip"；
   *   不命中 "c:/library/a.zip"、"c:/lib2/a.zip"、"c:/lib_x/a.zip"、"c:/li"。
   */
  listPresentAssetsUnderPath(prefixNorm: string): { id: number; path: string; path_norm: string }[] {
    if (!prefixNorm) return [];
    // normalizePath 会去掉尾斜杠，只有根 "/" 例外；这里统一按"去掉尾斜杠后的基路径 + /"算边界，
    // 于是 "c:/lib/" 与 "c:/lib" 完全等价（相等分支也用基路径，不因尾斜杠漂移）。
    // 入参必须先走 normalizePath：path_norm 列永远是小写、正斜杠、无尾斜杠。少了这一步，调用方传
    // "C:\\lib" 或 "c:/lib/" 时，等值那半边会失配（范围那半边不会，但会漏掉前缀自身这条记录）。
    const n = normalizePath(prefixNorm);
    const base = n.replace(/\/+$/, "");
    const eq = base === "" ? "/" : base;
    const lower = base === "" ? "/" : base + "/";
    const upper = base === "" ? "0" : base + "0";
    return this.stmt(
      "SELECT id, path, path_norm FROM assets WHERE status='present' AND (path_norm = ? OR (path_norm >= ? AND path_norm < ?))"
    ).all(eq, lower, upper) as any[];
  }
  /** 通用事务包装：扫描批次登记（createItem + registerAssets）必须整批原子（失败回滚，不留孤儿条目）。 */
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  /** 已在事务里就直接执行（不叠加 savepoint），否则开一个事务——批量入队/链式写入共用。 */
  transactionIfNeeded<T>(fn: () => T): T { return this.db.inTransaction ? fn() : this.db.transaction(fn)(); }

  // ---------- 扫描清单（v0.6.1 发现集成；TEMP 表，免迁移、随连接回收） ----------
  /**
   * 建/清本轮扫描清单（每个 scan 作业开始调一次）。两张 TEMP 表：
   *  - scan_seen(path_norm PK)：本轮**已提交批次**见过的候选，判缺用 NOT EXISTS（等价旧 seen Set）；
   *  - scan_assets(asset_id PK)：本轮入队深度索引的资产，用于有界 drain（避免把 assetIds 全量留在内存）。
   * TEMP 表只在本连接可见；不落盘、不需要迁移；跑完保留供诊断（bench/诊断面板可查行数）。
   */
  resetScanSeen(): void {
    this.db.exec("CREATE TEMP TABLE IF NOT EXISTS scan_seen(path_norm TEXT PRIMARY KEY)");
    this.db.exec("CREATE TEMP TABLE IF NOT EXISTS scan_assets(asset_id INTEGER PRIMARY KEY)");
    this.db.exec("DELETE FROM scan_seen");
    this.db.exec("DELETE FROM scan_assets");
  }
  /**
   * 批边界落账：一条固定 400 行占位的 INSERT OR IGNORE（末块用最后一个真实值补齐，重复键被 IGNORE）。
   * 固定占位是 task-17 的要求：避免"末块长度 1..400"生成 400 种 SQL 文本、把语句缓存冲爆。
   */
  insertScanSeenBatch(pathNorms: string[]): void {
    const rows = pathNorms.filter((p) => typeof p === "string" && p.length > 0);
    if (rows.length === 0) return;
    const CHUNK = Repo.BATCH_CHUNK;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK);
      const padded = part.slice();
      while (padded.length < CHUNK) padded.push(part[part.length - 1]!);
      this.stmt(`INSERT OR IGNORE INTO scan_seen(path_norm) VALUES ${"(?),".repeat(CHUNK - 1)}(?)`).run(...padded);
    }
  }
  /** 登记本批入队深度索引的资产 id（有界 drain 用；固定 400 占位，末块补最后一个真实 id）。 */
  insertScanAssetsBatch(assetIds: number[], fence?: JobFence): void {
    const ids = assetIds.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length === 0) return;
    if (fence) {
      // FIX-07：每行 INSERT…SELECT 都带 EXISTS(jobs) 校验；旧持有者 0 行，不会把 id 写进本轮清单。
      const st = this.stmt("INSERT OR IGNORE INTO scan_assets(asset_id) SELECT ? WHERE EXISTS (SELECT 1 FROM jobs j WHERE j.id=? AND j.holder=? AND j.lease_token=?)");
      for (const id of ids) st.run(id, fence.jobId, fence.holder, fence.token);
      return;
    }
    const CHUNK = Repo.BATCH_CHUNK;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      const padded = part.slice();
      while (padded.length < CHUNK) padded.push(part[part.length - 1]!);
      if (fence) continue; // 围栏路径在循环外统一处理（逐行 INSERT…SELECT，避免 400×4 绑定参数拼接）
      this.stmt(`INSERT OR IGNORE INTO scan_assets(asset_id) VALUES ${"(?),".repeat(CHUNK - 1)}(?)`).run(...padded);
    }
  }
  scanSeenCount(): number { return Number((this.stmt("SELECT COUNT(*) c FROM scan_seen").get() as any)?.c ?? 0); }
  scanSeenHas(pathNorm: string): boolean { return !!this.stmt("SELECT 1 FROM scan_seen WHERE path_norm=?").get(pathNorm); }
  // ---- 扫描条目清单（task-20 R3：替代 runner 里无界的 scratch.itemIds Set）----
  resetScanItems(): void {
    this.db.exec("CREATE TEMP TABLE IF NOT EXISTS scan_items(item_id INTEGER PRIMARY KEY)");
    this.db.exec("DELETE FROM scan_items");
  }
  /** 固定 400 行占位（末块补最后一个真实 id；OR IGNORE 去重），SQL 文本形状固定。 */
  insertScanItemsBatch(itemIds: number[]): void {
    const ids = itemIds.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length === 0) return;
    const CHUNK = Repo.BATCH_CHUNK;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      const padded = part.slice();
      while (padded.length < CHUNK) padded.push(part[part.length - 1]!);
      this.stmt(`INSERT OR IGNORE INTO scan_items(item_id) VALUES ${"(?),".repeat(CHUNK - 1)}(?)`).run(...padded);
    }
  }
  listScanItemsBatch(afterId: number, limit = 200): number[] {
    return (this.stmt("SELECT item_id FROM scan_items WHERE item_id > ? ORDER BY item_id LIMIT ?").all(afterId, Math.min(1000, Math.max(1, limit))) as any[])
      .map((r) => Number(r.item_id));
  }
  deleteScanItemsThrough(itemId: number): number {
    return this.stmt("DELETE FROM scan_items WHERE item_id <= ?").run(itemId).changes;
  }
  countScanItems(): number { return Number((this.stmt("SELECT COUNT(*) c FROM scan_items").get() as any)?.c ?? 0); }
  /** R5：本轮扫描入队的资产里仍 queued 的任务数（背压只看本轮，而不是全库历史积压）。 */
  countQueuedScanAssets(): number {
    return Number((this.stmt(
      "SELECT COUNT(*) c FROM index_tasks t WHERE t.state='queued' AND t.asset_id IN (SELECT asset_id FROM scan_assets)"
    ).get() as any)?.c ?? 0);
  }
  /**
   * 本轮"未见"的 present 资产（判缺）：路径边界与 listPresentAssetsUnderPath 完全一致
   * （等值 + [prefix+"/", prefix+"0") 范围，不经 LIKE），再 NOT EXISTS scan_seen。
   * 返回的是**已确认缺失候选**（数量通常很小），深度过滤由调用方做（语义与旧 depthOf 一致）。
   */
  listMissingUnderPath(prefixNorm: string): { id: number; path: string; path_norm: string }[] {
    if (!prefixNorm) return [];
    const n = normalizePath(prefixNorm);
    const base = n.replace(/\/+$/, "");
    const eq = base === "" ? "/" : base;
    const lower = base === "" ? "/" : base + "/";
    const upper = base === "" ? "0" : base + "0";
    return this.stmt(
      "SELECT id, path, path_norm FROM assets a WHERE a.status='present' " +
      "AND (a.path_norm = ? OR (a.path_norm >= ? AND a.path_norm < ?)) " +
      "AND NOT EXISTS (SELECT 1 FROM scan_seen s WHERE s.path_norm = a.path_norm)"
    ).all(eq, lower, upper) as any[];
  }
  /** 不完整扫描的**诊断**计数：同上但只 COUNT（不做深度过滤，仅用于 scan_incomplete 事件，不写库）。 */
  countMissingUnderPath(prefixNorm: string): number {
    if (!prefixNorm) return 0;
    const n = normalizePath(prefixNorm);
    const base = n.replace(/\/+$/, "");
    const eq = base === "" ? "/" : base;
    const lower = base === "" ? "/" : base + "/";
    const upper = base === "" ? "0" : base + "0";
    return Number((this.stmt(
      "SELECT COUNT(*) c FROM assets a WHERE a.status='present' " +
      "AND (a.path_norm = ? OR (a.path_norm >= ? AND a.path_norm < ?)) " +
      "AND NOT EXISTS (SELECT 1 FROM scan_seen s WHERE s.path_norm = a.path_norm)"
    ).get(eq, lower, upper) as any)?.c ?? 0);
  }
  /** 本轮入队资产里仍在飞的流水线任务数（queued/running/waiting_retry）。 */
  countActiveScanAssets(): number {
    return Number((this.stmt(
      "SELECT COUNT(*) c FROM index_tasks t WHERE t.state IN ('queued','running','waiting_retry') " +
      "AND t.asset_id IN (SELECT asset_id FROM scan_assets)"
    ).get() as any)?.c ?? 0);
  }
  /**
   * 合并条目：把 source 的资产/图片/模型/标签/更新历史/导入登记迁到 target，source 软删（可恢复）。
   * 用于"同一商品的模型包 + 材质包分两个压缩包"这种应当算一条素材的情况。
   */
  mergeItems(sourceId: number, targetId: number): { movedAssets: number; movedImages: number; targetId: number; categoryInherited: boolean; categoryConflicts: { categoryId: string; sourceCategoryId: string; targetCategoryId: string; kept: "target" }[] } {
    if (sourceId === targetId) throw Object.assign(new Error("不能合并到自己"), { code: "INVALID_INPUT", status: 400 });
    const src = this.stmt("SELECT * FROM items WHERE id=?").get(sourceId) as any;
    const tgt = this.stmt("SELECT * FROM items WHERE id=?").get(targetId) as any;
    if (!src || !tgt) throw Object.assign(new Error("条目不存在"), { code: "NOT_FOUND", status: 404 });
    const now2 = now();
    const tx = this.db.transaction(() => {
      const movedAssets = this.stmt("UPDATE assets SET item_id=? WHERE item_id=?").run(targetId, sourceId).changes;
      const movedImages = this.stmt("UPDATE item_images SET item_id=? WHERE item_id=?").run(targetId, sourceId).changes;
      // 目标没有封面时，借用来源的封面
      if (!tgt.cover_image_id && src.cover_image_id) {
        this.stmt("UPDATE items SET cover_image_id=? WHERE id=?").run(src.cover_image_id, targetId);
      } else if (!tgt.cover_image_id) {
        const first = this.stmt("SELECT id FROM item_images WHERE item_id=? ORDER BY position, id LIMIT 1").get(targetId) as any;
        if (first) this.stmt("UPDATE items SET cover_image_id=? WHERE id=?").run(first.id, targetId);
      }
      this.stmt("UPDATE item_images SET position = position + 1000 WHERE item_id=?").run(targetId);
      this.stmt("UPDATE item_images SET position = position - 1000 WHERE item_id=? AND position >= 1000").run(targetId);
      // FIX-08：图片已迁到 target；source 的 cover_image_id 必须清空，否则 source 仍引用已迁走的图，
      // 之后删除该图会被 ON DELETE RESTRICT 拒绝（merge → 删除第一张缩略图即报错）。
      this.stmt("UPDATE items SET cover_image_id=NULL WHERE id=?").run(sourceId);
      // 模型关联：并集，人工/已确认优先
      const srcAv = this.stmt("SELECT * FROM item_avatars WHERE item_id=?").all(sourceId) as any[];
      for (const a of srcAv) {
        const cur = this.stmt("SELECT source FROM item_avatars WHERE item_id=? AND avatar_id=?").get(targetId, a.avatar_id) as any;
        if (!cur) this.stmt("INSERT INTO item_avatars(item_id, avatar_id, match, confidence, evidence, source) VALUES (?,?,?,?,?,?)")
          .run(targetId, a.avatar_id, a.match, a.confidence, a.evidence, a.source);
        else if (cur.source === "auto" && a.source !== "auto") this.stmt("UPDATE item_avatars SET source=?, confidence=?, evidence=? WHERE item_id=? AND avatar_id=?")
          .run(a.source, a.confidence, a.evidence, targetId, a.avatar_id);
      }
      this.stmt("DELETE FROM item_avatars WHERE item_id=?").run(sourceId);
      // 标签并集
      const srcTags = this.stmt("SELECT tag_id, source FROM item_tags WHERE item_id=?").all(sourceId) as any[];
      for (const t of srcTags) this.stmt("INSERT OR IGNORE INTO item_tags(item_id, tag_id, source) VALUES (?,?,?)").run(targetId, t.tag_id, t.source);
      this.stmt("DELETE FROM item_tags WHERE item_id=?").run(sourceId);
      // 更新历史 / 快照 / 已导入登记
      this.stmt("UPDATE updates SET item_id=? WHERE item_id=?").run(targetId, sourceId);
      this.stmt("UPDATE source_snapshots SET item_id=? WHERE item_id=?").run(targetId, sourceId);
      this.stmt("UPDATE OR IGNORE project_imports SET item_id=? WHERE item_id=?").run(targetId, sourceId);
      this.stmt("DELETE FROM project_imports WHERE item_id=?").run(sourceId);
      // 来源信息：目标没有 BOOTH 号而来源有 → 继承
      const patch: any = { status: "trashed", notes: "已合并到 #" + targetId + "《" + tgt.title + "》" };
      const tgtSets: string[] = []; const tgtVals: unknown[] = [];
      if (!tgt.source_item_id && src.source_item_id) {
        for (const k of ["source_site", "source_item_id", "source_url", "canonical_url", "shop_name", "shop_subdomain", "author", "price_text", "price_yen", "category_name", "category_parent"]) {
          if (src[k] !== null && src[k] !== undefined && (tgt[k] === null || tgt[k] === undefined)) { tgtSets.push(k + " = ?"); tgtVals.push(src[k]); }
        }
      }
      if (tgtSets.length) { tgtSets.push("updated_at = ?"); tgtVals.push(now2, targetId); this.stmt("UPDATE items SET " + tgtSets.join(", ") + " WHERE id=?").run(...tgtVals as any[]); }
      else this.stmt("UPDATE items SET updated_at=? WHERE id=?").run(now2, targetId);
      // 分类归属合并（§7：合并出现分类冲突只提示，不静默覆盖）
      //  - 目标未分类 → 继承来源的分类（含证据）
      //  - 用户已定 vs 自动 → 用户的赢
      //  - 两边都是用户已定且不同 → 保留目标，只记冲突（写审计 + 记建议），由用户决定
      const categoryConflicts: { categoryId: string; sourceCategoryId: string; targetCategoryId: string; kept: "target" }[] = [];
      let categoryInherited = false;
      const srcCat = (src.cat_id ?? null) as string | null;
      const tgtCat = (tgt.cat_id ?? null) as string | null;
      const statusOf = (j: any) => { const row = this.stmt("SELECT cat_id, cat_source FROM items WHERE id=?").get(j) as any; return row; };
      const tgtNow = statusOf(targetId);
      if (srcCat && !tgtNow.cat_id) {
        this.stmt(`UPDATE items SET cat_id=?, cat_sub_id=?, cat_source=?, cat_confidence=?, cat_reason=?, cat_evidence=?, cat_assigned_at=? WHERE id=?`)
          .run(src.cat_id, src.cat_sub_id ?? null, src.cat_source ?? "migrated", src.cat_confidence ?? null, src.cat_reason ?? null, src.cat_evidence ?? null, src.cat_assigned_at ?? now2, targetId);
        categoryInherited = true;
      } else if (srcCat && tgtNow.cat_id && srcCat !== tgtNow.cat_id) {
        const srcUser = src.cat_source === "manual" || src.cat_source === "confirmed";
        const tgtUser = tgtNow.cat_source === "manual" || tgtNow.cat_source === "confirmed";
        if (srcUser && !tgtUser) {
          this.stmt(`UPDATE items SET cat_id=?, cat_sub_id=?, cat_source=?, cat_confidence=?, cat_reason=?, cat_evidence=?, cat_assigned_at=? WHERE id=?`)
            .run(src.cat_id, src.cat_sub_id ?? null, src.cat_source, src.cat_confidence ?? null, src.cat_reason ?? null, src.cat_evidence ?? null, now2, targetId);
          categoryInherited = true;
        } else if (srcUser && tgtUser) {
          categoryConflicts.push({ categoryId: srcCat, sourceCategoryId: srcCat, targetCategoryId: tgtNow.cat_id, kept: "target" });
          // 冲突提示：不作为建议自动应用（建议只写"合并来源 #N 的分类是 X"供人工判断），此处只写审计
          this.logAudit("merge.category_conflict", "item", String(targetId), { sourceCategoryId: srcCat, sub: src.cat_sub_id ?? null }, { keptCategoryId: tgtNow.cat_id });
        }
      }
      const sets = Object.entries(patch).map(([k]) => k + " = ?");
      this.stmt("UPDATE items SET " + sets.join(", ") + ", updated_at=? WHERE id=?").run(...Object.values(patch) as any[], now2, sourceId);
      return { movedAssets, movedImages, targetId, categoryInherited, categoryConflicts };
    });
    const r = tx();
    this.syncFts(targetId);
    this.syncFts(sourceId);
    return r;
  }

  /** 把某条目的资产整体挪到另一条目（用于"本地条目关联 BOOTH 商品后发现重复"的合并）。 */
  moveAssets(fromItemId: number, toItemId: number): number {
    const r = this.stmt("UPDATE assets SET item_id = ? WHERE item_id = ?").run(toItemId, fromItemId);
    return r.changes;
  }
  /**
   * 批量标缺失。SQLite 变量上限 32766：必须分块，否则大库（>3.2 万资产）整轮 scan 在写完资产后失败（verifier A4）。
   * 单事务 + 每块 500：原子且不会长时间持有写锁。
   */
  markAssetsMissing(ids: number[], fence?: JobFence): void {
    if (ids.length === 0) return;
    const unique = [...new Set(ids.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (unique.length === 0) return;
    const CHUNK = 500;
    const tx = this.db.transaction(() => {
      for (let i = 0; i < unique.length; i += CHUNK) {
        const part = unique.slice(i, i + CHUNK);
        const ph = part.map(() => "?").join(",");
        // FIX-07：有 fence 时只有 jobs 行仍属该 holder+token 才允许标缺失（接管后 0 行）
        if (fence) this.stmt(`UPDATE assets SET status='missing' WHERE id IN (${ph})` + JOB_FENCE_SQL).run(...part as any[], fence.jobId, fence.holder, fence.token);
        else this.stmt(`UPDATE assets SET status='missing' WHERE id IN (${ph})`).run(...part);
      }
    });
    tx();
  }
  touchAsset(id: number): void { this.stmt("UPDATE assets SET last_verified_at=? WHERE id=?").run(now(), id); }
  setAssetSha(id: number, sha: string | null, state: "ok" | "error" | "pending"): void { this.stmt("UPDATE assets SET sha256=?, sha256_state=? WHERE id=?").run(sha, state, id); }

  replaceArchiveEntries(assetId: number, entries: { path: string; size: number; isDir: boolean; ext?: string | null }[]): void {
    const tx = this.db.transaction((rows: typeof entries) => {
      this.stmt("DELETE FROM archive_entries WHERE asset_id=?").run(assetId);
      const ins = this.stmt("INSERT OR IGNORE INTO archive_entries(asset_id, entry_path, entry_size, is_dir, ext) VALUES (?,?,?,?,?)");
      for (const e of rows) ins.run(assetId, e.path, e.size ?? 0, e.isDir ? 1 : 0, e.ext ?? null);
    });
    tx(entries);
  }
  getArchiveEntries(assetId: number) { return this.stmt("SELECT entry_path AS path, entry_size AS size, is_dir AS isDir, ext FROM archive_entries WHERE asset_id=? ORDER BY entry_path").all(assetId) as any[]; }
  countArchiveEntries(assetId: number): number { return (this.stmt("SELECT COUNT(*) c FROM archive_entries WHERE asset_id=?").get(assetId) as any).c; }

  replaceUnityPackageAssets(assetId: number, assets: { guid: string; assetPath: string; type: string | null; size: number | null; hasPreview: boolean }[]): void {
    const tx = this.db.transaction((rows: typeof assets) => {
      this.stmt("DELETE FROM unitypackage_assets WHERE asset_id=?").run(assetId);
      const ins = this.stmt("INSERT OR IGNORE INTO unitypackage_assets(asset_id, guid, asset_path, type, size, has_preview) VALUES (?,?,?,?,?,?)");
      for (const a of rows) ins.run(assetId, a.guid, a.assetPath, a.type, a.size, a.hasPreview ? 1 : 0);
    });
    tx(assets);
  }
  getUnityPackageAssets(assetId: number) { return this.stmt("SELECT guid, asset_path AS assetPath, type, size, has_preview AS hasPreview FROM unitypackage_assets WHERE asset_id=? ORDER BY asset_path").all(assetId) as any[]; }

  // ---------- avatars ----------
  listAvatars(q: { ownedOnly?: boolean; q?: string } = {}): AvatarCard[] {
    const w: string[] = []; const params: unknown[] = [];
    if (q.ownedOnly) w.push("a.owned = 1");
    if (q.q) { w.push("(a.name LIKE ? OR a.name_norm LIKE ? OR EXISTS(SELECT 1 FROM avatar_aliases al WHERE al.avatar_id=a.id AND (al.alias LIKE ? OR al.alias_norm LIKE ?)))"); const l = `%${q.q}%`; const ln = `%${normKey(q.q)}%`; params.push(l, ln, l, ln); }
    const where = w.length ? " WHERE " + w.join(" AND ") : "";
    const rows = this.stmt(`SELECT a.*, (SELECT COUNT(*) FROM item_avatars ia JOIN items i ON i.id=ia.item_id WHERE ia.avatar_id=a.id AND ia.match<>'exclude' AND i.status<>'trashed') AS item_count
      FROM avatars a${where} ORDER BY a.sort, a.name`).all(...params as any[]) as any[];
    const aliasRows = this.stmt("SELECT avatar_id, alias FROM avatar_aliases ORDER BY id").all() as any[];
    const byAvatar = new Map<number, string[]>();
    for (const r of aliasRows) { const l = byAvatar.get(r.avatar_id) ?? []; l.push(r.alias); byAvatar.set(r.avatar_id, l); }
    return rows.map((r) => ({ ...r, ownedBool: r.owned === 1, itemCount: r.item_count ?? 0, aliases: byAvatar.get(r.id) ?? [] })) as AvatarCard[];
  }
  getAvatar(id: number): AvatarRow | null { return (this.stmt("SELECT * FROM avatars WHERE id=?").get(id) as AvatarRow) ?? null; }
  findAvatarByAlias(normalized: string): AvatarRow | null {
    return (this.stmt("SELECT a.* FROM avatars a JOIN avatar_aliases al ON al.avatar_id=a.id WHERE al.alias_norm=?").get(normalized) as AvatarRow)
      ?? (this.stmt("SELECT * FROM avatars WHERE name_norm=?").get(normalized) as AvatarRow) ?? null;
  }
  createAvatar(input: { name: string; kind?: AvatarKind; owned?: boolean; boothItemId?: string | null; aliases?: string[] }): AvatarRow {
    const t = now(); const nn = normKey(input.name);
    const info = this.stmt("INSERT INTO avatars(name, name_norm, kind, booth_item_id, owned, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(input.name, nn, input.kind ?? "avatar", input.boothItemId ?? null, input.owned ? 1 : 0, 0, t, t);
    const id = Number(info.lastInsertRowid);
    const addAlias = this.stmt("INSERT INTO avatar_aliases(avatar_id, alias, alias_norm, lang, source) VALUES (?,?,?,?,?)");
    for (const a of input.aliases ?? []) { try { addAlias.run(id, a, normKey(a), null, "seed"); } catch { /* 别名冲突：跳过，路由层会报告 */ } }
    return this.getAvatar(id)!;
  }
  updateAvatar(id: number, patch: Partial<AvatarRow>): AvatarRow {
    const allowed = ["name", "kind", "booth_item_id", "cover_path", "owned", "sort"];
    const sets: string[] = []; const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) { if (allowed.includes(k) && v !== undefined) { sets.push(`${k} = ?`); params.push(v as any); } }
    if (patch.name !== undefined) { sets.push("name_norm = ?"); params.push(normKey(String(patch.name))); }
    if (sets.length) { sets.push("updated_at = ?"); params.push(now(), id); this.stmt(`UPDATE avatars SET ${sets.join(", ")} WHERE id=?`).run(...params as any[]); }
    return this.getAvatar(id)!;
  }
  deleteAvatar(id: number): void { this.stmt("DELETE FROM avatars WHERE id=?").run(id); }
  listAliases(avatarId: number): AvatarAliasRow[] { return this.stmt("SELECT * FROM avatar_aliases WHERE avatar_id=? ORDER BY id").all(avatarId) as AvatarAliasRow[]; }
  addAlias(avatarId: number, alias: string, lang: string | null, source: AvatarAliasRow["source"]): AvatarAliasRow {
    const info = this.stmt("INSERT INTO avatar_aliases(avatar_id, alias, alias_norm, lang, source) VALUES (?,?,?,?,?)").run(avatarId, alias, normKey(alias), lang, source);
    return this.stmt("SELECT * FROM avatar_aliases WHERE id=?").get(info.lastInsertRowid) as AvatarAliasRow;
  }
  deleteAlias(avatarId: number, aliasId: number): void { this.stmt("DELETE FROM avatar_aliases WHERE id=? AND avatar_id=?").run(aliasId, avatarId); }
  mergeAvatars(fromId: number, intoId: number): void {
    const tx = this.db.transaction(() => {
      this.stmt("UPDATE OR IGNORE item_avatars SET avatar_id=? WHERE avatar_id=?").run(intoId, fromId);
      this.stmt("DELETE FROM item_avatars WHERE avatar_id=?").run(fromId);
      this.stmt("UPDATE OR IGNORE asset_avatars SET avatar_id=? WHERE avatar_id=?").run(intoId, fromId);
      this.stmt("DELETE FROM asset_avatars WHERE avatar_id=?").run(fromId);
      this.stmt("UPDATE OR IGNORE avatar_aliases SET avatar_id=? WHERE avatar_id=?").run(intoId, fromId);
      this.stmt("DELETE FROM avatar_aliases WHERE avatar_id=?").run(fromId);
      this.stmt("DELETE FROM avatars WHERE id=?").run(fromId);
      this.stmt("UPDATE avatars SET updated_at=? WHERE id=?").run(now(), intoId);
    });
    tx();
  }
  setItemAvatars(itemId: number, ids: number[], source: "auto" | "manual" | "confirmed", match: AvatarMatch = "any", confidence = 1, evidence: string | null = null): void {
    const tx = this.db.transaction(() => {
      const ins = this.stmt(`INSERT INTO item_avatars(item_id, avatar_id, match, confidence, evidence, source) VALUES (?,?,?,?,?,?)
        ON CONFLICT(item_id, avatar_id) DO UPDATE SET match=excluded.match, confidence=excluded.confidence, evidence=COALESCE(excluded.evidence, item_avatars.evidence), source=excluded.source`);
      for (const id of ids) ins.run(itemId, id, match, confidence, evidence, source);
    });
    tx();
  }
  removeItemAvatar(itemId: number, avatarId: number): void { this.stmt("DELETE FROM item_avatars WHERE item_id=? AND avatar_id=?").run(itemId, avatarId); }
  /** 条目当前标签名（自动分类的证据来源之一） */
  listItemTagNames(itemId: number): string[] { return this.itemTagsFor([itemId]).get(itemId) ?? []; }
  listItemAvatars(itemId: number) { return this.stmt("SELECT ia.*, a.name, a.name_norm FROM item_avatars ia JOIN avatars a ON a.id=ia.avatar_id WHERE ia.item_id=? ORDER BY a.name").all(itemId) as any[]; }
  setAssetAvatar(assetId: number, avatarId: number, entryPrefix: string | null, confidence: number, evidence: string | null): void {
    this.stmt(`INSERT INTO asset_avatars(asset_id, avatar_id, entry_prefix, confidence, evidence) VALUES (?,?,?,?,?)
      ON CONFLICT(asset_id, avatar_id, IFNULL(entry_prefix,'')) DO UPDATE SET confidence=excluded.confidence, evidence=excluded.evidence`)
      .run(assetId, avatarId, entryPrefix, confidence, evidence);
  }
  listAssetAvatars(assetId: number) { return this.stmt("SELECT aa.*, a.name FROM asset_avatars aa JOIN avatars a ON a.id=aa.avatar_id WHERE aa.asset_id=? ORDER BY a.name").all(assetId) as any[]; }

  // ---------- tags ----------
  listTags() { return this.stmt("SELECT t.*, (SELECT COUNT(*) FROM item_tags it WHERE it.tag_id=t.id) AS itemCount FROM tags t ORDER BY t.namespace, t.name").all(); }
  ensureTag(name: string, namespace: string | null = null, color: string | null = null): number {
    const existing = this.stmt("SELECT id FROM tags WHERE IFNULL(namespace,'') = IFNULL(?,'') AND name = ?").get(namespace, name) as any;
    if (existing) return existing.id;
    return Number(this.stmt("INSERT INTO tags(name, namespace, color, sort) VALUES (?,?,?,0)").run(name, namespace, color).lastInsertRowid);
  }
  /** 全量替换条目标签（UI 的标签编辑用；自动标签也一并由传入列表决定）。 */
  setItemTags(itemId: number, names: string[], source: "auto" | "manual"): void {
    const tx = this.db.transaction(() => {
      this.stmt("DELETE FROM item_tags WHERE item_id = ?").run(itemId);
      const ins = this.stmt("INSERT OR IGNORE INTO item_tags(item_id, tag_id, source) VALUES (?,?,?)");
      for (const n of names) { if (!n?.trim()) continue; ins.run(itemId, this.ensureTag(n.trim()), source); }
    });
    tx();
    this.syncFts(itemId);
  }
  reorderImages(itemId: number, imageIds: number[]): void {
    const tx = this.db.transaction(() => {
      const upd = this.stmt("UPDATE item_images SET position = ? WHERE id = ? AND item_id = ?");
      imageIds.forEach((id, i) => upd.run(i, id, itemId));
    });
    tx();
  }
  attachTags(itemId: number, names: string[], source: "auto" | "manual"): void {
    const tx = this.db.transaction(() => {
      const ins = this.stmt("INSERT OR IGNORE INTO item_tags(item_id, tag_id, source) VALUES (?,?,?)");
      for (const n of names) { if (!n?.trim()) continue; ins.run(itemId, this.ensureTag(n.trim()), source); }
    });
    tx();
    this.syncFts(itemId);
  }

  // ---------- jobs ----------
  createJob(kind: JobKind, itemId: number | null, payload: unknown, priority = 0): JobRow {
    if (itemId !== null) {
      const existing = this.stmt(`SELECT * FROM jobs WHERE item_id=? AND kind=? AND state IN ('queued','resolving','fetching','materializing','indexing','matching','releasing','releasing_done','paused')`).get(itemId, kind) as JobRow | undefined;
      if (existing) return existing;
    }
    const info = this.stmt("INSERT INTO jobs(kind, item_id, payload, state, attempts, priority, created_at) VALUES (?,?,?,'queued',0,?,?)")
      .run(kind, itemId, payload === undefined ? null : JSON.stringify(payload), priority, now());
    return this.getJob(Number(info.lastInsertRowid))!;
  }
  getJob(id: number): JobRow | null { return (this.stmt("SELECT * FROM jobs WHERE id=?").get(id) as JobRow) ?? null; }
  listJobs(state?: string, limit = 100): JobRow[] {
    if (state) return this.stmt("SELECT * FROM jobs WHERE state=? ORDER BY priority DESC, id DESC LIMIT ?").all(state, limit) as JobRow[];
    return this.stmt("SELECT * FROM jobs ORDER BY id DESC LIMIT ?").all(limit) as JobRow[];
  }
  nextQueuedJob(): JobRow | null { return (this.stmt("SELECT * FROM jobs WHERE state='queued' ORDER BY priority DESC, id ASC LIMIT 1").get() as JobRow) ?? null; }
  /**
   * CAS 领取 + 租约：queued → resolving 原子完成（verifier A1）。
   * 多 runner / 多进程抢同一条时，只有 changes=1 的那个拿到；失败者返回 null，绝不能 stopFail 别人的作业。
   * v6：同一 UPDATE 写 holder/lease_until/heartbeat_at，并把 lease_token+1（fencing token）——
   * 旧持有者即使还活着，之后的写入也会因为 token 不匹配被拒绝。
   */
  claimNextJob(holder: string = "local#" + process.pid, opts: { leaseMs?: number; now?: string } = {}): JobWithLease | null {
    const pick = this.stmt("SELECT id FROM jobs WHERE state='queued' ORDER BY priority DESC, id ASC LIMIT 1").get() as { id: number } | undefined;
    if (!pick) return null;
    const at = opts.now ?? now();
    const until = leaseUntilOf(at, opts.leaseMs ?? DEFAULT_JOB_LEASE_MS);
    const tx = this.db.transaction(() => {
      const info = this.stmt(
        "UPDATE jobs SET state='resolving', started_at=?, attempts=attempts+1, holder=?, lease_until=?, heartbeat_at=?, lease_token=lease_token+1 " +
        "WHERE id=? AND state='queued'"
      ).run(at, holder, until, at, pick.id);
      if (info.changes !== 1) return null;
      this.stmt("INSERT INTO job_events(job_id, at, from_state, to_state, event, detail) VALUES (?,?,?,?,?,?)").run(pick.id, at, "queued", "resolving", "start", null);
      return this.getJob(pick.id) as JobWithLease;
    });
    return tx() as JobWithLease | null;
  }
  /**
   * 续租：只续"仍是自己的"那一行。false = 已丢租约（被用户暂停/取消、或已被接管）——
   * 调用方必须立即停止作业写入；仓库层不在这里改状态（避免第二套状态机）。
   */
  renewLease(id: number, lease: JobLease, opts: { leaseMs?: number; now?: string } = {}): boolean {
    const at = opts.now ?? now();
    const until = leaseUntilOf(at, opts.leaseMs ?? DEFAULT_JOB_LEASE_MS);
    const info = this.stmt("UPDATE jobs SET lease_until=?, heartbeat_at=? WHERE id=? AND holder=? AND lease_token=?")
      .run(until, at, id, lease.holder, lease.token);
    return info.changes === 1;
  }
  /** 只读检查：当前是否仍持有租约（诊断用；不作为写入许可）。 */
  holdsLease(id: number, lease: JobLease): boolean {
    const row = this.stmt("SELECT holder, lease_token FROM jobs WHERE id=?").get(id) as { holder: string | null; lease_token: number } | undefined;
    return !!row && row.holder === lease.holder && Number(row.lease_token) === Number(lease.token);
  }
  /**
   * 过期租约回收（v6）：把租约已失效的在飞作业退回 queued，供任意 runner 重新领取。
   *
   * 逐行 CAS（id + state + lease_token + **UPDATE 里重新判过期**）：
   *  - 心跳已续租的活作业不会被误伤（不认 SELECT 时的旧快照）；
   *  - 已完成/已暂停的作业不会被复活（不在状态集合里，且行级 CAS 失败）；
   *  - 旧持有者的迟到写入随后会被 token 围栏拒绝。
   * 事件沿用 `recovered`（毒作业计数口径不变），detail 区分 service restart / lease expired。
   *
   * protectHolder：**不要回收这个 holder 的过期租约**。JobRunner 的 maintenance 定时器必须传自己：
   * 事件循环被长同步段阻塞 > leaseMs 时，heartbeat 与 maintenance 可能同时到期；若 maintenance 先跑，
   * 会把本进程仍在执行的作业 reap 成 queued（重复执行）。自己的租约只能由自己的心跳续/丢，跨进程
   * 接管仍按过期正常进行（其他 holder 不受保护）。
   */
  reapExpiredLeases(opts: { now?: string; reason?: "service restart" | "lease expired"; protectHolder?: string } = {}): number {
    const at = opts.now ?? now();
    const reason = opts.reason ?? "lease expired";
    // 自己的行永不回收；holder IS NULL 是 v5 遗留（无主）行，仍按过期/NULL 回收。
    const stamp = " AND (holder IS NULL OR holder <> ?)"; // 仅在 protectHolder 存在时拼接（预编译语句按 SQL 文本缓存）
    const rows = this.stmt(
      `SELECT id, state, holder, lease_token, lease_until FROM jobs
       WHERE state IN (${LEASABLE_JOB_STATES}) AND (lease_until IS NULL OR lease_until < ?)` + (opts.protectHolder ? stamp : "")
    ).all(...(opts.protectHolder ? [at, opts.protectHolder] : [at])) as { id: number; state: JobState; holder: string | null; lease_token: number; lease_until: string | null }[];
    let requeued = 0;
    const tx = this.db.transaction(() => {
      for (const j of rows) {
        // 反复崩溃的"毒作业"不能让服务无限重启循环：同一作业恢复 >=3 次即放弃并留证据。
        const rec = this.stmt("SELECT COUNT(*) c FROM job_events WHERE job_id=? AND event='recovered'").get(j.id) as any;
        if (Number(rec?.c) >= 3) {
          const info = this.stmt("UPDATE jobs SET state='failed', finished_at=?, error=?, holder=NULL, lease_until=NULL WHERE id=? AND state=? AND lease_token=?")
            .run(at, "反复崩溃（已恢复 " + Number(rec.c) + " 次），自动放弃以免无限重启", j.id, j.state, j.lease_token);
          if (info.changes === 1) {
            this.stmt("INSERT INTO job_events(job_id, at, from_state, to_state, event, detail) VALUES (?,?,?,?,?,?)")
              .run(j.id, at, j.state, "failed", "abandoned_after_recoveries", "too many recoveries");
            // v7：作业被放弃也不是"子任务永远 running"的理由——退回 queued 让流水线收尾（内容索引与作业终态独立）
            this.resetRunningTasksForJob(j.id);
          }
          continue;
        }
        const detail = reason === "service restart"
          ? "service restart"
          : "lease expired (holder=" + (j.holder ?? "?") + ", token=" + j.lease_token + ", until=" + (j.lease_until ?? "null") + ")";
        // 行级 CAS：再次校验过期 + 保护自己的 holder（防"SELECT 后自己刚续租/刚重新领取"的窗口）
        const info = opts.protectHolder
          ? this.stmt(
              "UPDATE jobs SET state='queued', started_at=NULL, error=NULL, holder=NULL, lease_until=NULL, lease_token=lease_token+1 " +
              "WHERE id=? AND state=? AND lease_token=? AND (lease_until IS NULL OR lease_until < ?) AND (holder IS NULL OR holder <> ?)"
            ).run(j.id, j.state, j.lease_token, at, opts.protectHolder)
          : this.stmt(
              "UPDATE jobs SET state='queued', started_at=NULL, error=NULL, holder=NULL, lease_until=NULL, lease_token=lease_token+1 " +
              "WHERE id=? AND state=? AND lease_token=? AND (lease_until IS NULL OR lease_until < ?)"
            ).run(j.id, j.state, j.lease_token, at);
        if (info.changes !== 1) continue;
        // v7：同一事务里把该作业名下的 running 子任务退回 queued 并换租约（旧 worker 立即被围栏）
        this.resetRunningTasksForJob(j.id);
        this.stmt("INSERT INTO job_events(job_id, at, from_state, to_state, event, detail) VALUES (?,?,?,?,?,?)")
          .run(j.id, at, j.state, "queued", "recovered", detail);
        requeued++;
      }
    });
    tx();
    return requeued;
  }
  /**
   * CAS 转移：只允许冻结转移表里的边；非法事件 409；失败态复读由调用方处理。
   *
   * v6 租约围栏：传入 lease 时，CAS 追加 holder + lease_token 条件。0 行 ⇒ LeaseLostError(409)，
   * **且绝不写事件** —— 旧持有者（崩溃后复活 / 心跳中断后被接管）的迟到写入只能被拒绝。
   * 未传 lease 的调用是"用户操作"（HTTP pause/cancel/retry），行为与旧版完全一致。
   * 到 paused / 终态时释放 holder/lease_until（token 保留，继续围栏旧持有者）。
   */
  transitionJob(id: number, event: JobEvent, detail?: string, lease?: JobLease): JobRow {
    const job = this.getJob(id);
    if (!job) throw Object.assign(new Error("job not found"), { code: "NOT_FOUND", status: 404 });
    const to = resolveTransition(job.state, event, { attempts: job.attempts });
    if (!to) throw Object.assign(new Error(`非法转移: ${job.state} --${event}-->`), { code: "INVALID_TRANSITION", status: 409 });
    const attempts = event === "retry" && to === "queued" ? job.attempts + 1 : job.attempts;
    const started = job.started_at ?? (to === "resolving" ? now() : null);
    const finished = (to === "done" || to === "cancelled" || to === "abandoned" || to === "failed") ? now() : null;
    const errorValue = to === "failed" ? (detail ?? job.error ?? null) : (to === "done" ? null : job.error);
    const release = (to === "done" || to === "failed" || to === "cancelled" || to === "abandoned" || to === "paused") ? 1 : 0;
    // 状态与事件必须原子：崩溃窗口里"状态已前进、事件丢失"会让崩溃取证断链（verifier R5）
    const tx = this.db.transaction(() => {
      const info = lease
        ? this.stmt("UPDATE jobs SET state=?, attempts=?, started_at=?, finished_at=?, error=?, " +
            "holder=CASE WHEN ?=1 THEN NULL ELSE holder END, lease_until=CASE WHEN ?=1 THEN NULL ELSE lease_until END " +
            "WHERE id=? AND state=? AND holder=? AND lease_token=?")
          .run(to, attempts, started, finished, errorValue, release, release, id, job.state, lease.holder, lease.token)
        : this.stmt("UPDATE jobs SET state=?, attempts=?, started_at=?, finished_at=?, error=?, " +
            "holder=CASE WHEN ?=1 THEN NULL ELSE holder END, lease_until=CASE WHEN ?=1 THEN NULL ELSE lease_until END " +
            "WHERE id=? AND state=?")
          .run(to, attempts, started, finished, errorValue, release, release, id, job.state);
      if (info.changes !== 1) {
        if (lease) throw new LeaseLostError("租约已失效：job " + id + " 已不属于 " + lease.holder + "#" + lease.token);
        throw Object.assign(new Error("状态已被并发修改"), { code: "CONFLICT", status: 409 });
      }
      this.stmt("INSERT INTO job_events(job_id, at, from_state, to_state, event, detail) VALUES (?,?,?,?,?,?)").run(id, now(), job.state, to, event, detail ?? null);
    });
    tx();
    return this.getJob(id)!;
  }
  /**
   * 追加诊断事件（不改状态）。带 lease 时做围栏：只允许当前持有者写；
   * 过期持有者的迟到事件被静默丢弃（返回 false），不抛错、不污染事件流。
   *
   * v0.6.1 task-13：唯一可能高频的诊断事件 `discovery_throttled` 在 coalesceWindowMs 窗口内合并到
   * **同一 job_id + event** 的最后一条（只更新 detail 的 count/lastAt，不新增行）；绝不跨 job 合并。
   * 关键状态转移事件不经过这里（transitionJob 自己写），因此永不被合并。
   */
  logJobEvent(id: number, from: JobState | null, to: JobState, event: string, detail?: string, lease?: JobLease): boolean {
    if (event === "discovery_throttled") {
      if (lease && !this.holdsLease(id, lease)) return false;
      if (this.coalesceJobEvent(id, event, detail, lease)) return true;
    }
    if (lease) {
      const info = this.stmt(
        "INSERT INTO job_events(job_id, at, from_state, to_state, event, detail) " +
        "SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM jobs WHERE id=? AND holder=? AND lease_token=?)"
      ).run(id, now(), from, to, event, detail ?? null, id, lease.holder, lease.token);
      return info.changes === 1;
    }
    this.stmt("INSERT INTO job_events(job_id, at, from_state, to_state, event, detail) VALUES (?,?,?,?,?,?)").run(id, now(), from, to, event, detail ?? null);
    return true;
  }
  /** 把同一 job+event 的高频诊断合并进窗口内最后一条（返回 true=已合并，不新增行）。 */
  private coalesceJobEvent(id: number, event: string, detail: string | undefined, lease?: JobLease): boolean {
    const cfg = this.getEventRetentionConfig();
    if (!(cfg.coalesceWindowMs > 0)) return false;
    const atIso = now();
    const last = this.stmt("SELECT id, at, detail FROM job_events WHERE job_id=? AND event=? ORDER BY id DESC LIMIT 1").get(id, event) as any;
    if (!last) return false;
    const lastAt = Date.parse(String(last.at));
    if (!Number.isFinite(lastAt) || Date.parse(atIso) - lastAt > cfg.coalesceWindowMs) return false;
    let prev: any = null, next: any = null;
    try { prev = JSON.parse(String(last.detail ?? "{}")); } catch { return false; }
    try { next = JSON.parse(String(detail ?? "{}")); } catch { return false; }
    if (!prev || typeof prev !== "object" || Array.isArray(prev) || !next || typeof next !== "object" || Array.isArray(next)) return false;
    const merged = { ...prev, ...next, count: Number(prev.count ?? 1) + 1, lastAt: atIso };
    const info = lease
      ? this.stmt(
          "UPDATE job_events SET detail=? WHERE id=? AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND holder=? AND lease_token=?)"
        ).run(JSON.stringify(merged), last.id, id, lease.holder, lease.token)
      : this.stmt("UPDATE job_events SET detail=? WHERE id=?").run(JSON.stringify(merged), last.id);
    return info.changes === 1;
  }
  listJobEvents(id: number) { return this.stmt("SELECT * FROM job_events WHERE job_id=? ORDER BY id").all(id); }
  /**
   * 启动恢复：租约感知的过期回收（保留旧入口名/签名）。
   * 只动"从未领取（NULL 租约，旧库）"或"租约已过期"的在飞作业；**有效租约一律不碰** ——
   * 这样另一个活实例正在执行的作业不会被本实例启动时误伤（旧实现的无条件 requeue 已修）。
   */
  recoverInFlight(): number { return this.reapExpiredLeases({ reason: "service restart" }); }

  // ---------- snapshots / updates ----------
  addSnapshot(itemId: number, provider: string, data: { jsonHash?: string | null; files?: unknown; priceText?: string | null; imageUrls?: unknown }): void {
    this.stmt("INSERT INTO source_snapshots(item_id, captured_at, provider, json_hash, files_json, price_text, image_urls_json) VALUES (?,?,?,?,?,?,?)")
      .run(itemId, now(), provider, data.jsonHash ?? null, data.files === undefined ? null : JSON.stringify(data.files), data.priceText ?? null, data.imageUrls === undefined ? null : JSON.stringify(data.imageUrls));
  }
  latestSnapshot(itemId: number): any { return this.stmt("SELECT * FROM source_snapshots WHERE item_id=? ORDER BY id DESC LIMIT 1").get(itemId); }
  addUpdate(itemId: number, kind: UpdateKind, detail: unknown): void { this.stmt("INSERT INTO updates(item_id, detected_at, kind, detail_json, applied) VALUES (?,?,?,?,0)").run(itemId, now(), kind, JSON.stringify(detail ?? null)); }
  listUpdates(itemId: number) { return this.stmt("SELECT * FROM updates WHERE item_id=? ORDER BY id DESC").all(itemId); }
  markUpdatesApplied(itemId: number): void { this.stmt("UPDATE updates SET applied=1 WHERE item_id=?").run(itemId); }

  // ---------- collections（套装/合集）----------
  listCollections(): any[] {
    return this.stmt("SELECT c.*, (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id=c.id) AS itemCount FROM collections c ORDER BY c.sort, c.name").all();
  }
  ensureCollection(name: string): number {
    const ex = this.stmt("SELECT id FROM collections WHERE name=?").get(name) as any;
    if (ex) return ex.id;
    return Number(this.stmt("INSERT INTO collections(name, kind, sort, created_at) VALUES (?, 'manual', 0, ?)").run(name, now()).lastInsertRowid);
  }
  addToCollection(collectionId: number, itemIds: number[]): number {
    const tx = this.db.transaction(() => {
      let n = 0;
      const ins = this.stmt("INSERT OR IGNORE INTO collection_items(collection_id, item_id, position) VALUES (?,?,?)");
      for (const id of itemIds) n += ins.run(collectionId, id, 0).changes;
      return n;
    });
    return tx();
  }
  removeFromCollection(collectionId: number, itemId: number): void {
    this.stmt("DELETE FROM collection_items WHERE collection_id=? AND item_id=?").run(collectionId, itemId);
  }
  deleteCollection(id: number): void { this.stmt("DELETE FROM collections WHERE id=?").run(id); }
  collectionsOfItem(itemId: number): { id: number; name: string }[] {
    return this.stmt("SELECT c.id, c.name FROM collection_items ci JOIN collections c ON c.id=ci.collection_id WHERE ci.item_id=? ORDER BY c.name").all(itemId) as any[];
  }
  collectionItems(collectionId: number): number[] {
    return (this.stmt("SELECT item_id FROM collection_items WHERE collection_id=? ORDER BY position, item_id").all(collectionId) as any[]).map((r) => r.item_id);
  }

  // ---------- projects ----------
  listProjects() { return this.stmt("SELECT p.*, (SELECT COUNT(*) FROM project_imports pi WHERE pi.project_id=p.id) AS importCount FROM projects p ORDER BY p.id").all(); }
  ensureProject(name: string, path: string): number {
    const pn = normalizePath(path);
    const ex = this.stmt("SELECT id FROM projects WHERE path_norm=?").get(pn) as any;
    if (ex) return ex.id;
    return Number(this.stmt("INSERT INTO projects(name, path, path_norm, created_at) VALUES (?,?,?,?)").run(name, path, pn, now()).lastInsertRowid);
  }
  /** 记下工程用的 Unity 版本（导入时由编辑器自己报，比人填可靠）。 */
  setProjectUnityVersion(projectId: number, version: string | null): void {
    this.stmt("UPDATE projects SET unity_version=?, last_scan_at=? WHERE id=?").run(version, now(), projectId);
  }
  addProjectImport(projectId: number, itemId: number, assetId: number | null, note: string | null): void {
    this.stmt("INSERT OR REPLACE INTO project_imports(project_id, item_id, asset_id, imported_at, note) VALUES (?,?,?,?,?)").run(projectId, itemId, assetId, now(), note);
  }

  // ---------- categories（物品分类）----------
  // 定义真源：packages/core/src/categories/taxonomy.ts（首次建库由 migrate 播种进 categories 表）
  private _catDefs: CategoryDef[] | null = null;

  /** 分类定义（进程内缓存；写操作后调用 invalidateCategories()）。 */
  categoryDefs(force = false): CategoryDef[] {
    if (!this._catDefs || force) {
      const rows = this.stmt("SELECT id, name, parent_id, sort, enabled, builtin FROM categories ORDER BY sort, id").all() as any[];
      this._catDefs = rows.map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id ?? null, sort: r.sort ?? 0, enabled: r.enabled !== 0, builtin: r.builtin !== 0 }));
    }
    return this._catDefs;
  }
  invalidateCategories(): void { this._catDefs = null; }

  /** 供 API 返回的分类树（含计数）。counts 由 categoryStats() 提供。 */
  listCategories(): CategoryNode[] {
    const defs = this.categoryDefs();
    const counts = new Map<string, number>();
    for (const c of this.categoryStats().counts) counts.set(c.id, c.count);
    const build = (parentId: string | null): CategoryNode[] =>
      defs.filter((d) => d.parentId === parentId).sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id))
        .map((d) => ({ id: d.id, name: d.name, parentId: d.parentId, sort: d.sort, enabled: d.enabled, builtin: d.builtin, itemCount: counts.get(d.id) ?? 0, children: d.parentId === null ? build(d.id) : undefined }));
    const tree = build(null);
    // 兜底：父分类已被删/未知的孤儿（数据被手改过时也不至于整棵树丢掉）
    const known = new Set(defs.map((d) => d.id));
    for (const c of counts.keys()) if (!known.has(c)) tree.push({ id: c, name: c, parentId: null, sort: 9999, enabled: false, builtin: false, itemCount: counts.get(c) ?? 0, children: [] });
    return tree;
  }

  private static parseJsonOrNull(s: string | null | undefined): unknown[] | null {
    if (!s) return null;
    try { const v = JSON.parse(s); return Array.isArray(v) ? v : null; } catch { return null; }
  }

  categoryAssignment(r: any): CategoryAssignment | null {
    const id = (r?.cat_id ?? null) as string | null;
    // 「未分类」是系统分类，不是一条归属：UI 上要显示灰 chip「未分类」，所以这里返回 null
    if (!id || id === UNCATEGORIZED_ID) return null;
    const defs = this.categoryDefs();
    const cat = defs.find((d) => d.id === id) ?? null;
    const sub = r.cat_sub_id ? defs.find((d) => d.id === r.cat_sub_id) ?? null : null;
    return {
      categoryId: id, categoryName: cat?.name ?? id,
      subCategoryId: sub?.id ?? null, subCategoryName: sub?.name ?? r.cat_sub_id ?? null,
      source: (r.cat_source ?? null) as CategoryRefSource | null,
      confidence: r.cat_confidence ?? null,
      evidence: Repo.parseJsonOrNull(r.cat_evidence),
      reason: r.cat_reason ?? null,
      assignedAt: r.cat_assigned_at ?? null,
    };
  }

  categorySuggestion(r: any): CategorySuggestion | null {
    const id = (r?.cat_suggest_id ?? null) as string | null;
    if (!id) return null;
    const defs = this.categoryDefs();
    const cat = defs.find((d) => d.id === id) ?? null;
    const sub = r.cat_suggest_sub_id ? defs.find((d) => d.id === r.cat_suggest_sub_id) ?? null : null;
    return {
      categoryId: id, categoryName: cat?.name ?? id,
      subCategoryId: sub?.id ?? null, subCategoryName: sub?.name ?? r.cat_suggest_sub_id ?? null,
      confidence: r.cat_suggest_confidence ?? 0,
      reason: r.cat_suggest_reason ?? null,
      evidence: Repo.parseJsonOrNull(r.cat_suggest_evidence),
      suggestedAt: r.cat_suggest_at ?? null,
    };
  }

  /** 建分类（用户自定义）。父分类必须已存在（两层限制由 DB 的 ON DELETE RESTRICT + 服务层校验兜底）。 */
  createCategory(input: { id?: string; name: string; parentId?: string | null; sort?: number }): CategoryNode {
    const parentId = input.parentId ?? null;
    if (parentId) {
      const parent = this.categoryDefs().find((d) => d.id === parentId);
      if (!parent) throw Object.assign(new Error("父分类不存在: " + parentId), { code: "INVALID_INPUT", status: 400 });
      // 结构固定两层：父必须是主分类，否则会建出第三层（validateTaxonomy 会报错、UI 也渲染不出）
      if (parent.parentId !== null) {
        throw Object.assign(new Error("父分类必须是主分类（分类结构固定两层）: " + parentId), { code: "INVALID_INPUT", status: 400 });
      }
    }
    const id = (input.id ?? "").trim() || ("c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    if (this.categoryDefs().some((d) => d.id === id)) throw Object.assign(new Error("分类 ID 已存在: " + id), { code: "CONFLICT", status: 409 });
    const t = now();
    const sort = input.sort ?? (parentId ? (this.stmt("SELECT COALESCE(MAX(sort),0)+10 s FROM categories WHERE IFNULL(parent_id,'')=IFNULL(?,'')").get(parentId) as any).s : 2000);
    this.stmt("INSERT INTO categories(id, name, parent_id, sort, enabled, builtin, created_at, updated_at) VALUES (?,?,?,?,1,0,?,?)")
      .run(id, input.name.trim(), parentId, sort, t, t);
    this.invalidateCategories();
    this.logAudit("category.create", "category", id, null, { id, name: input.name, parentId });
    const node = this.listCategories().flatMap((n) => [n, ...(n.children ?? [])]).find((n) => n.id === id);
    return node ?? { id, name: input.name, parentId, sort, enabled: true, builtin: false, itemCount: 0, children: parentId ? undefined : [] };
  }

  updateCategory(id: string, patch: { name?: string; parentId?: string | null; sort?: number; enabled?: boolean }): CategoryNode {
    const defs = this.categoryDefs();
    const cur = defs.find((d) => d.id === id);
    if (!cur) throw Object.assign(new Error("分类不存在: " + id), { code: "NOT_FOUND", status: 404 });
    const sets: string[] = []; const params: unknown[] = [];
    if (patch.name !== undefined) { sets.push("name = ?"); params.push(String(patch.name).trim()); }
    if (patch.sort !== undefined) { sets.push("sort = ?"); params.push(patch.sort); }
    if (patch.enabled !== undefined) { sets.push("enabled = ?"); params.push(patch.enabled ? 1 : 0); }
    if (patch.parentId !== undefined && patch.parentId !== cur.parentId) {
      // v3 §6.2：允许把**子分类移动到另一个一级分类**下（ID 不变；ID 是稳定标识，不随位置变化）。
      // 主分类不能变成子分类（它的 ID 是一级的），有子分类的分类不能移动。
      if (patch.parentId === null) {
        throw Object.assign(new Error("不支持把分类提升为一级分类（ID 已固定，请新建一级分类再合并）"), { code: "INVALID_INPUT", status: 400 });
      }
      const target = defs.find((d) => d.id === patch.parentId);
      if (!target) throw Object.assign(new Error("父分类不存在: " + patch.parentId), { code: "INVALID_INPUT", status: 400 });
      if (target.parentId !== null) throw Object.assign(new Error("目标必须是主分类（结构固定两层）: " + patch.parentId), { code: "INVALID_INPUT", status: 400 });
      // 顺序有意：先报"还有子分类"（409），再报"一级骨架不能下挂"（400）——两者都拦，但先给更具体的冲突
      const kids = defs.filter((d) => d.parentId === id).length;
      if (kids > 0) throw Object.assign(new Error("该分类下还有 " + kids + " 个子分类，不能移动"), { code: "CONFLICT", status: 409 });
      if (cur.parentId === null) throw Object.assign(new Error("一级分类不能挂到别的分类下（请新建普通子分类，或把子分类移动到目标一级下）"), { code: "INVALID_INPUT", status: 400 });
      sets.push("parent_id = ?"); params.push(patch.parentId);
    }
    if (sets.length === 0) return this.listCategories().flatMap((n) => [n, ...(n.children ?? [])]).find((n) => n.id === id)!;
    sets.push("updated_at = ?"); params.push(now(), id);
    this.stmt(`UPDATE categories SET ${sets.join(", ")} WHERE id = ?`).run(...params as any[]);
    this.invalidateCategories();
    this.logAudit("category.update", "category", id, cur, patch);
    return this.listCategories().flatMap((n) => [n, ...(n.children ?? [])]).find((n) => n.id === id)!;
  }

  /** 删除分类：其下素材退回未分类（不删素材）。有子分类时拒绝（先处理子分类）。 */
  deleteCategory(id: string, opts: { transferTo?: string | null } = {}): { moved: number; movedSubs: number; movedSuggestions: number; deleted: number } {
    const defs = this.categoryDefs();
    const self = defs.find((d) => d.id === id);
    if (!self) throw Object.assign(new Error("分类不存在: " + id), { code: "NOT_FOUND", status: 404 });
    // 内置分类不能删：migrate 每次启动会按 ID 播种（DO NOTHING 只护住"已存在"的行），删了下次启动就复活。
    // 想让它从选择列表消失请用 PATCH enabled=false（已有归属不会被静默改数据）。
    if (self.builtin) throw Object.assign(new Error("内置分类不能删除，请改用停用（enabled=false）"), { code: "CONFLICT", status: 409 });
    const kids = defs.filter((d) => d.parentId === id).length;
    if (kids > 0) throw Object.assign(new Error(`该分类下还有 ${kids} 个子分类，请先删除或移动`), { code: "CONFLICT", status: 409 });
    // 转移目标：指定分类（一级或子级）或未分类（缺省）。
    // 绝不删除素材、不碰磁盘文件、不动来源/导入/回收站等任何其它关系（v3 §6.3）。
    const transferTo = opts.transferTo ?? null;
    let tTop: string | null = null; let tSub: string | null = null;
    if (transferTo) {
      const target = this.categoryDefs().find((d) => d.id === transferTo);
      if (!target) throw Object.assign(new Error("转移目标不存在: " + transferTo), { code: "INVALID_INPUT", status: 400 });
      if (target.parentId === null) tTop = target.id === UNCATEGORIZED_ID ? null : target.id;
      else { tTop = target.parentId; tSub = target.id; }
    }
    // 显式指定「未分类」作为转移目标 → 素材整条降级（清主分类 + 子分类），语义与文案一致
    const explicitUncat = transferTo !== null && tTop === null && tSub === null;
    const clearAll = "UPDATE items SET cat_id=NULL, cat_sub_id=NULL, cat_source=NULL, cat_confidence=NULL, cat_reason=NULL, cat_evidence=NULL, cat_assigned_at=NULL, updated_at=? WHERE ";
    const tx = this.db.transaction(() => {
      const t = now();
      // 子分类被删：素材改指转移目标（或清空子分类，主分类仍在）
      // 未给 transferTo：只清子分类，主分类保留（默认语义）
      // 给了 transferTo：**cat_id 与 cat_sub_id 一起写**，避免"子分类属于 A、主分类还是 B"的不自洽
      const movedSubs = transferTo === null
        ? this.stmt("UPDATE items SET cat_sub_id=NULL, updated_at=? WHERE cat_sub_id=?").run(t, id).changes
        : explicitUncat
          ? this.stmt(clearAll + "cat_sub_id=?").run(t, id).changes
          : this.stmt("UPDATE items SET cat_id=?, cat_sub_id=?, cat_source='manual', cat_assigned_at=?, updated_at=? WHERE cat_sub_id=?").run(tTop, tSub, t, t, id).changes;
      // 一级分类被删：素材改指转移目标（或整体回未分类）
      const moved = (tTop === null && tSub === null)
        ? this.stmt(clearAll + "cat_id=?").run(t, id).changes
        : this.stmt("UPDATE items SET cat_id=?, cat_sub_id=?, cat_source='manual', cat_assigned_at=?, updated_at=? WHERE cat_id=?").run(tTop, tSub, t, t, id).changes;
      // 指向它的待确认建议：目标存在则改指目标，否则清掉（不留悬空 ID）
      const movedSuggestions = tTop === null
        ? this.stmt(`UPDATE items SET cat_suggest_id=NULL, cat_suggest_sub_id=NULL, cat_suggest_confidence=NULL, cat_suggest_reason=NULL,
            cat_suggest_evidence=NULL, cat_suggest_at=NULL WHERE cat_suggest_id=? OR cat_suggest_sub_id=?`).run(id, id).changes
        : this.stmt("UPDATE items SET cat_suggest_id=?, cat_suggest_sub_id=? WHERE cat_suggest_id=? OR cat_suggest_sub_id=?").run(tTop, tSub, id, id).changes;
      const deleted = this.stmt("DELETE FROM categories WHERE id=?").run(id).changes;
      this.logAudit("category.delete", "category", id, defs.find((d) => d.id === id) ?? null, { moved, movedSubs, movedSuggestions, transferTo });
      return { moved, movedSubs, movedSuggestions, deleted };
    });
    const r = tx();
    this.invalidateCategories();
    return r;
  }

  /** 用户路径：无条件写入分类归属（手选/采纳建议/批量）。同时清掉待确认建议（用户已经决定了）。 */
  setItemCategory(itemId: number, input: { categoryId: string | null; subCategoryId?: string | null; source: CategoryRefSource; confidence?: number | null; reason?: string | null; evidence?: string | null }): ItemRow {
    const defs = this.categoryDefs();
    let catId = input.categoryId ?? null;
    let subId = input.subCategoryId ?? null;
    if (catId) {
      const cat = defs.find((d) => d.id === catId);
      if (!cat) throw Object.assign(new Error("分类不存在: " + catId), { code: "INVALID_INPUT", status: 400 });
      if (cat.parentId !== null) { subId = cat.id; catId = cat.parentId; } // 传了子分类 ID → 自动归位到其主分类
      if (subId) {
        const sub = defs.find((d) => d.id === subId);
        if (!sub || sub.parentId !== catId) subId = null; // 非法子分类 → 清空，绝不留下非法关联
      }
    } else {
      subId = null;
    }
    const before = this.stmt("SELECT cat_id, cat_sub_id, cat_source FROM items WHERE id=?").get(itemId) as any;
    const t = now();
    this.stmt(`UPDATE items SET cat_id=?, cat_sub_id=?, cat_source=?, cat_confidence=?, cat_reason=?, cat_evidence=?, cat_assigned_at=?,
        cat_suggest_id=NULL, cat_suggest_sub_id=NULL, cat_suggest_confidence=NULL, cat_suggest_reason=NULL, cat_suggest_evidence=NULL, cat_suggest_at=NULL,
        updated_at=? WHERE id=?`)
      .run(catId, subId, catId ? input.source : null, catId ? (input.confidence ?? (input.source === "manual" ? 1 : null)) : null,
        catId ? (input.reason ?? null) : null, catId ? (input.evidence ?? null) : null, catId ? t : null, t, itemId);
    this.logAudit("item.category", "item", String(itemId), before ?? null, { catId, subId, source: input.source });
    return this.itemRow(itemId);
  }

  /** 只写建议，不动已有归属。 */
  suggestItemCategory(itemId: number, rec: { categoryId: string; subCategoryId?: string | null; confidence: number; reason?: string | null; evidence?: string | null }): void {
    const defs = this.categoryDefs();
    if (!defs.some((d) => d.id === rec.categoryId)) return;
    let subId = rec.subCategoryId ?? null;
    if (subId && !defs.some((d) => d.id === subId && d.parentId === rec.categoryId)) subId = null;
    this.stmt(`UPDATE items SET cat_suggest_id=?, cat_suggest_sub_id=?, cat_suggest_confidence=?, cat_suggest_reason=?, cat_suggest_evidence=?, cat_suggest_at=? WHERE id=?`)
      .run(rec.categoryId, subId, rec.confidence, rec.reason ?? null, rec.evidence ?? null, now(), itemId);
  }

  clearItemCategorySuggestion(itemId: number): void {
    this.stmt(`UPDATE items SET cat_suggest_id=NULL, cat_suggest_sub_id=NULL, cat_suggest_confidence=NULL, cat_suggest_reason=NULL, cat_suggest_evidence=NULL, cat_suggest_at=NULL WHERE id=?`).run(itemId);
  }

  /**
   * 自动路径（扫库/补全元数据/Inbox/后台任务）。**绝不覆盖用户已定分类**（manual/confirmed）：
   * 那种情况下只写待确认建议。返回是否真落到了归属上。
   */
  applyAutoCategory(itemId: number, rec: { categoryId: string; subCategoryId?: string | null; confidence: number; reason?: string | null; evidence?: string | null }): { applied: boolean; protected: boolean } {
    const cur = this.stmt("SELECT cat_id, cat_source FROM items WHERE id=?").get(itemId) as any;
    const userDecided = cur && (cur.cat_source === "manual" || cur.cat_source === "confirmed");
    if (userDecided) {
      if (cur.cat_id !== rec.categoryId) this.suggestItemCategory(itemId, rec);
      else this.clearItemCategorySuggestion(itemId); // 与用户既有选择一致 → 不需要打扰
      return { applied: false, protected: true };
    }
    this.setItemCategory(itemId, { categoryId: rec.categoryId, subCategoryId: rec.subCategoryId ?? null, source: "auto", confidence: rec.confidence, reason: rec.reason ?? null, evidence: rec.evidence ?? null });
    return { applied: true, protected: false };
  }

  itemRow(id: number): ItemRow { return this.stmt("SELECT * FROM items WHERE id=?").get(id) as ItemRow; }

  /** 分类统计（§8）：每个分类的素材数 + 已拥有/已收藏；另给未分类、待确认、缺文件数。全部按"未删除"口径，DISTINCT 计数避免 join 放大。 */
  categoryStats(): {
    counts: { id: string; name: string; parentId: string | null; count: number; topCount: number; owned: number; favorite: number }[];
    uncategorized: number; pending: number; total: number; missingFiles: number;
  } {
    const defs = this.categoryDefs();
    const one = (sql: string) => (this.stmt(sql).get() as any).v as number;
    const directTop = new Map<string, { count: number; owned: number; favorite: number }>();
    const directSub = new Map<string, { count: number; owned: number; favorite: number }>();
    const ownedExpr = "EXISTS(SELECT 1 FROM item_avatars ia JOIN avatars av ON av.id=ia.avatar_id WHERE ia.item_id=i.id AND av.owned=1)";
    const rows = this.stmt(`SELECT i.cat_id AS top, i.cat_sub_id AS sub, COUNT(*) AS c,
        SUM(CASE WHEN ${ownedExpr} THEN 1 ELSE 0 END) AS owned,
        SUM(CASE WHEN i.favorite=1 THEN 1 ELSE 0 END) AS fav
      FROM items i WHERE i.status<>'trashed' AND i.cat_id IS NOT NULL GROUP BY i.cat_id, i.cat_sub_id`).all() as any[];
    for (const r of rows) {
      const rec = { count: r.c as number, owned: (r.owned ?? 0) as number, favorite: (r.fav ?? 0) as number };
      const t = directTop.get(r.top) ?? { count: 0, owned: 0, favorite: 0 };
      directTop.set(r.top, { count: t.count + rec.count, owned: t.owned + rec.owned, favorite: t.favorite + rec.favorite });
      if (r.sub) {
        const s = directSub.get(r.sub) ?? { count: 0, owned: 0, favorite: 0 };
        directSub.set(r.sub, { count: s.count + rec.count, owned: s.owned + rec.owned, favorite: s.favorite + rec.favorite });
      }
    }
    const uncategorizedCount = one("SELECT COUNT(*) v FROM items WHERE status<>'trashed' AND (cat_id IS NULL OR cat_id = 'uncategorized')");
    const counts = defs.map((d) => {
      const direct = d.parentId === null ? directTop.get(d.id) : directSub.get(d.id);
      const c = d.id === UNCATEGORIZED_ID ? uncategorizedCount : (direct?.count ?? 0);
      return { id: d.id, name: d.name, parentId: d.parentId, count: c, topCount: c, owned: direct?.owned ?? 0, favorite: direct?.favorite ?? 0 };
    });
    return {
      counts,
      uncategorized: uncategorizedCount,
      pending: one("SELECT COUNT(*) v FROM items WHERE status<>'trashed' AND cat_suggest_id IS NOT NULL"),
      total: one("SELECT COUNT(*) v FROM items WHERE status<>'trashed'"),
      missingFiles: one("SELECT COUNT(DISTINCT a.item_id) v FROM assets a JOIN items i ON i.id=a.item_id WHERE a.status='missing' AND i.status<>'trashed'"),
    };
  }

  logAudit(action: string, entity: string, entityId: string | null, before: unknown, after: unknown): void {
    this.stmt("INSERT INTO audit_log(at, actor, action, entity, entity_id, before_json, after_json) VALUES (?,?,?,?,?,?,?)")
      .run(now(), "user", action, entity, entityId, before === undefined || before === null ? null : JSON.stringify(before), after === undefined || after === null ? null : JSON.stringify(after));
  }
  listAudit(limit = 100) { return this.stmt("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit); }

  // ---------- categories：筛选计数 / 影响面 / 移动 / 合并 ----------
  /**
   * 当前筛选下的分类计数（**一次 GROUP BY**，不是每个分类查一次）。
   * 分类筛选本身不参与计数（否则只会剩被选中的那个分类）；其它筛选（关键词/标签/avatar/来源/状态/容器/已导入/收藏）都生效。
   */
  categoryCounts(q: ItemQuery = {}): { all: number; uncategorized: number; tops: Record<string, number>; subs: Record<string, number> } {
    const { sql: where, params } = this.buildWhere({ ...q, categoryIds: undefined, categoryMatch: undefined, uncategorized: false, pendingCategory: false });
    const w = where || "";
    const one = (extra: string) => (this.stmt("SELECT COUNT(*) c FROM items i" + w + extra).get(...params as any[]) as any).c as number;
    const all = one("");
    const uncategorized = one((w ? " AND " : " WHERE ") + "(i.cat_id IS NULL OR i.cat_id = '" + UNCATEGORIZED_ID + "')");
    const rows = this.stmt("SELECT i.cat_id AS top, i.cat_sub_id AS sub, COUNT(*) c FROM items i" + w + " GROUP BY i.cat_id, i.cat_sub_id").all(...params as any[]) as any[];
    const tops: Record<string, number> = {}; const subs: Record<string, number> = {};
    for (const r of rows) {
      if (!r.top) continue;
      tops[r.top] = (tops[r.top] ?? 0) + r.c;
      if (r.sub) subs[r.sub] = (subs[r.sub] ?? 0) + r.c;
    }
    tops[UNCATEGORIZED_ID] = uncategorized; // 未分类也作为一个"一级分类"参与导航计数
    return { all, uncategorized, tops, subs };
  }

  /** 删除/合并前的影响面（UI 二次确认要显示的数字）。 */
  categoryImpact(id: string): { items: number; direct: number; subs: number; suggestions: number; children: { id: string; name: string }[] } {
    const defs = this.categoryDefs();
    const self = defs.find((d) => d.id === id);
    if (!self) throw Object.assign(new Error("分类不存在: " + id), { code: "NOT_FOUND", status: 404 });
    const one = (sql: string, ...p: unknown[]) => (this.stmt(sql).get(...p as any[]) as any).c as number;
    const direct = self.parentId === null
      ? one("SELECT COUNT(*) c FROM items WHERE status<>'trashed' AND cat_id=?", id)
      : one("SELECT COUNT(*) c FROM items WHERE status<>'trashed' AND cat_sub_id=?", id);
    const items = self.parentId === null
      ? one("SELECT COUNT(*) c FROM items WHERE status<>'trashed' AND (cat_id=? OR cat_sub_id IN (SELECT id FROM categories WHERE parent_id=?))", id, id)
      : direct;
    return {
      items, direct,
      subs: defs.filter((d) => d.parentId === id).length,
      suggestions: one("SELECT COUNT(*) c FROM items WHERE cat_suggest_id=? OR cat_suggest_sub_id=?", id, id),
      children: defs.filter((d) => d.parentId === id).map((d) => ({ id: d.id, name: d.name })),
    };
  }

  /** 把子分类移动到另一个一级分类下（ID 不变）。 */
  moveCategory(id: string, parentId: string): CategoryDef {
    const defs = this.categoryDefs();
    const self = defs.find((d) => d.id === id);
    if (!self) throw Object.assign(new Error("分类不存在: " + id), { code: "NOT_FOUND", status: 404 });
    if (self.parentId === null) throw Object.assign(new Error("只支持把子分类移动到另一个一级分类下（一级骨架不可移动）"), { code: "INVALID_INPUT", status: 400 });
    const target = defs.find((d) => d.id === parentId);
    if (!target) throw Object.assign(new Error("目标分类不存在: " + parentId), { code: "INVALID_INPUT", status: 400 });
    if (target.parentId !== null) throw Object.assign(new Error("目标必须是一级分类: " + parentId), { code: "INVALID_INPUT", status: 400 });
    if (target.id === self.parentId) return self;
    this.stmt("UPDATE categories SET parent_id=?, updated_at=? WHERE id=?").run(parentId, now(), id);
    this.invalidateCategories();
    this.logAudit("category.move", "category", id, { parentId: self.parentId }, { parentId });
    return this.categoryDefs().find((d) => d.id === id)!;
  }

  /** 合并分类：from 的素材与建议迁到 into，然后删除 from（事务）。只允许同级合并。 */
  mergeCategories(fromId: string, intoId: string): { moved: number; movedSuggestions: number; deleted: number } {
    if (fromId === intoId) throw Object.assign(new Error("不能合并到自己"), { code: "INVALID_INPUT", status: 400 });
    const defs = this.categoryDefs();
    const from = defs.find((d) => d.id === fromId); const into = defs.find((d) => d.id === intoId);
    if (!from || !into) throw Object.assign(new Error("分类不存在: " + (from ? intoId : fromId)), { code: "NOT_FOUND", status: 404 });
    if (from.builtin) throw Object.assign(new Error("系统分类不能作为合并源（可以合并到系统分类）"), { code: "CONFLICT", status: 409 });
    const fromTop = from.parentId === null; const intoTop = into.parentId === null;
    if (fromTop !== intoTop) throw Object.assign(new Error("只能同级合并（一级↔一级、子↔子）"), { code: "INVALID_INPUT", status: 400 });
    const tx = this.db.transaction(() => {
      const t = now();
      let moved = 0; let movedSuggestions = 0; let deleted = 0;
      if (fromTop) {
        moved += this.stmt("UPDATE items SET cat_id=?, updated_at=? WHERE cat_id=?").run(into.id, t, fromId).changes;
        movedSuggestions += this.stmt("UPDATE items SET cat_suggest_id=?, cat_suggest_sub_id=NULL WHERE cat_suggest_id=?").run(into.id, fromId).changes;
        for (const kid of defs.filter((d) => d.parentId === fromId).map((d) => d.id)) {
          moved += this.stmt("UPDATE items SET cat_sub_id=NULL, updated_at=? WHERE cat_sub_id=?").run(t, kid).changes;
          this.stmt("UPDATE items SET cat_suggest_sub_id=NULL WHERE cat_suggest_sub_id=?").run(kid);
          deleted += this.stmt("DELETE FROM categories WHERE id=?").run(kid).changes;
        }
      } else {
        moved += this.stmt("UPDATE items SET cat_sub_id=?, updated_at=? WHERE cat_sub_id=?").run(into.id, t, fromId).changes;
        movedSuggestions += this.stmt("UPDATE items SET cat_suggest_sub_id=? WHERE cat_suggest_sub_id=?").run(into.id, fromId).changes;
      }
      deleted += this.stmt("DELETE FROM categories WHERE id=?").run(fromId).changes;
      this.logAudit("category.merge", "category", fromId, { from: fromId }, { into: intoId, moved, movedSuggestions, deleted });
      return { moved, movedSuggestions, deleted };
    });
    const r = tx();
    this.invalidateCategories();
    return r;
  }

  // ---------- tags（v3：重命名 / 改色 / 删除 / 默认标签播种）----------
  private tagRow(id: number) { return this.stmt("SELECT t.*, (SELECT COUNT(*) FROM item_tags it WHERE it.tag_id=t.id) AS itemCount FROM tags t WHERE t.id=?").get(id); }

  updateTag(id: number, patch: { name?: string; color?: string | null; sort?: number }): any {
    const cur = this.tagRow(id) as any;
    if (!cur) throw Object.assign(new Error("标签不存在: " + id), { code: "NOT_FOUND", status: 404 });
    const sets: string[] = []; const params: unknown[] = [];
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw Object.assign(new Error("标签名不能为空"), { code: "INVALID_INPUT", status: 400 });
      const dup = this.stmt("SELECT id FROM tags WHERE IFNULL(namespace,'')=IFNULL(?,'') AND name=? AND id<>?").get(cur.namespace, name, id) as any;
      if (dup) throw Object.assign(new Error("已有同名标签（id=" + dup.id + "），可以合并到它"), { code: "CONFLICT", status: 409 });
      sets.push("name = ?"); params.push(name);
    }
    if (patch.color !== undefined) { sets.push("color = ?"); params.push(patch.color); }
    if (patch.sort !== undefined) { sets.push("sort = ?"); params.push(patch.sort); }
    if (sets.length === 0) return this.tagRow(id);
    params.push(id);
    this.stmt("UPDATE tags SET " + sets.join(", ") + " WHERE id=?").run(...params as any[]);
    this.logAudit("tag.update", "tag", String(id), { name: cur.name, color: cur.color }, patch);
    return this.tagRow(id);
  }

  /** 删除标签：同时删掉关联（不删素材、不删文件）。 */
  deleteTag(id: number): { removed: number } {
    const cur = this.tagRow(id) as any;
    if (!cur) throw Object.assign(new Error("标签不存在: " + id), { code: "NOT_FOUND", status: 404 });
    const tx = this.db.transaction(() => {
      const removed = this.stmt("DELETE FROM item_tags WHERE tag_id=?").run(id).changes;
      this.stmt("DELETE FROM tags WHERE id=?").run(id);
      this.logAudit("tag.delete", "tag", String(id), { name: cur.name }, { removed });
      return { removed };
    });
    return tx();
  }

  /** 默认标签只播种一次（settings.tags_seed_version）；用户删掉的不会被复活。 */
  seedDefaultTags(tags: readonly { name: string; color?: string; namespace?: string; sort?: number }[], version: string): number {
    if (this.getSetting("tags_seed_version") === version) return 0;
    const tx = this.db.transaction(() => {
      let added = 0;
      for (const t of tags) {
        const exists = this.stmt("SELECT id FROM tags WHERE IFNULL(namespace,'')=IFNULL(?,'') AND name=?").get(t.namespace ?? null, t.name) as any;
        if (exists) continue;
        this.stmt("INSERT INTO tags(name, namespace, color, sort) VALUES (?,?,?,?)").run(t.name, t.namespace ?? null, t.color ?? null, t.sort ?? 0);
        added++;
      }
      this.stmt("INSERT INTO settings(key, value) VALUES ('tags_seed_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(version);
      return added;
    });
    return tx();
  }

  // ---------- 扫描变更中心（M1）：持久化预览 ----------
  /** 比 listPresentAssetsUnderPath 多带 size/mtime/item_id（预览判「变化/未变」要用）；边界条件与它完全一致。 */
  presentAssetsUnderPath(prefixNorm: string): { id: number; path: string; path_norm: string; size: number; mtime: string | null; item_id: number }[] {
    if (!prefixNorm) return [];
    const n = normalizePath(prefixNorm);
    const base = n.replace(/\/+$/, "");
    const eq = base === "" ? "/" : base;
    const lower = base === "" ? "/" : base + "/";
    const upper = base === "" ? "0" : base + "0";
    return this.stmt(
      "SELECT id, path, path_norm, size, mtime, item_id FROM assets WHERE status='present' AND (path_norm = ? OR (path_norm >= ? AND path_norm < ?))"
    ).all(eq, lower, upper) as any[];
  }

  /** 同一「根路径 + 深度」是否已有活跃预览（幂等键）。 */
  findActiveScanPreview(pathNorm: string, deep: boolean): any {
    return this.stmt(
      "SELECT * FROM scan_previews WHERE path_norm=? AND deep=? AND state IN ('scanning','ready','partial','applying') ORDER BY id DESC LIMIT 1"
    ).get(normalizePath(pathNorm), deep ? 1 : 0) ?? null;
  }

  /** 建预览（幂等：同参数已有活跃预览时直接返回它，不新建）。 */
  createScanPreview(input: { rootId: number | null; path: string; deep: boolean; ttlMs?: number }): any {
    const pn = normalizePath(input.path);
    const active = this.findActiveScanPreview(pn, input.deep);
    if (active) return active;
    const t = now();
    const ttl = input.ttlMs ?? 24 * 3600 * 1000;
    const info = this.stmt(
      "INSERT INTO scan_previews(uid, root_id, path, path_norm, deep, state, generator_version, created_at, expires_at) VALUES (?,?,?,?,?,'scanning',1,?,?)"
    ).run(uid(), input.rootId, input.path, pn, input.deep ? 1 : 0, t, new Date(Date.now() + ttl).toISOString());
    return this.getScanPreview(Number(info.lastInsertRowid));
  }

  getScanPreview(id: number): any { return this.stmt("SELECT * FROM scan_previews WHERE id=?").get(id) ?? null; }
  listScanPreviews(limit = 50): any[] {
    return this.stmt("SELECT * FROM scan_previews ORDER BY id DESC LIMIT ?").all(Math.min(200, Math.max(1, limit)));
  }
  updateScanPreview(id: number, patch: Record<string, unknown>): any {
    const allowed = ["state", "plan_hash", "truncated", "complete", "files", "dirs", "bytes", "error_count",
      "counts_json", "scan_json", "error", "apply_job_id", "finished_at", "expires_at"];
    const sets: string[] = []; const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) { if (allowed.includes(k) && v !== undefined) { sets.push(k + " = ?"); params.push(v as any); } }
    if (sets.length) { params.push(id); this.stmt("UPDATE scan_previews SET " + sets.join(", ") + " WHERE id=?").run(...params as any[]); }
    return this.getScanPreview(id);
  }

  /** 整表替换预览条目（预览是快照语义，重新生成时全量覆盖）。分块写入避免大事务。 */
  replaceScanPreviewItems(previewId: number, rows: { path: string; path_norm: string; change: string; size?: number | null; mtime?: string | null;
    prevSize?: number | null; prevMtime?: string | null; assetId?: number | null; itemId?: number | null;
    container?: string | null; kind?: string | null; detail?: unknown }[]): number {
    const t = now();
    const ins = this.stmt(
      "INSERT OR REPLACE INTO scan_preview_items(preview_id, item_key, path, path_norm, change, size, mtime, prev_size, prev_mtime, asset_id, item_id, container, kind, decision, applied, detail_json, created_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',0,?,?)"
    );
    let n = 0;
    const tx = this.db.transaction((batch: typeof rows) => {
      for (const r of batch) {
        ins.run(previewId, r.path_norm, r.path, r.path_norm, r.change, r.size ?? null, r.mtime ?? null, r.prevSize ?? null, r.prevMtime ?? null,
          r.assetId ?? null, r.itemId ?? null, r.container ?? null, r.kind ?? null, r.detail === undefined ? null : JSON.stringify(r.detail), t);
        n++;
      }
    });
    this.stmt("DELETE FROM scan_preview_items WHERE preview_id=?").run(previewId);
    for (let i = 0; i < rows.length; i += 500) tx(rows.slice(i, i + 500));
    return n;
  }

  countScanPreviewItems(previewId: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.stmt("SELECT change, COUNT(*) c FROM scan_preview_items WHERE preview_id=? GROUP BY change").all(previewId) as any[]) out[r.change] = r.c;
    return out;
  }
  scanPreviewItemCounts(previewId: number): { total: number; accepted: number; applied: number; pending: number } {
    const one = (sql: string) => (this.stmt(sql).get(previewId) as any).c as number;
    return {
      total: one("SELECT COUNT(*) c FROM scan_preview_items WHERE preview_id=?"),
      accepted: one("SELECT COUNT(*) c FROM scan_preview_items WHERE preview_id=? AND decision='accept'"),
      applied: one("SELECT COUNT(*) c FROM scan_preview_items WHERE preview_id=? AND applied=1"),
      pending: one("SELECT COUNT(*) c FROM scan_preview_items WHERE preview_id=? AND applied=0 AND decision<>'skip'"),
    };
  }
  /** 分页读预览条目（keyset 分页：cursor = 上一页最后一条 id）。 */
  listScanPreviewItems(previewId: number, opts: { cursor?: number; limit?: number; change?: string } = {}): { items: any[]; nextCursor: number | null } {
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
    const w = ["preview_id = ?"]; const p: unknown[] = [previewId];
    if (opts.change) { w.push("change = ?"); p.push(opts.change); }
    if (opts.cursor && opts.cursor > 0) { w.push("id > ?"); p.push(opts.cursor); }
    const rows = this.stmt("SELECT * FROM scan_preview_items WHERE " + w.join(" AND ") + " ORDER BY id LIMIT ?").all(...p as any[], limit + 1) as any[];
    const more = rows.length > limit;
    const items = more ? rows.slice(0, limit) : rows;
    return { items, nextCursor: more ? items[items.length - 1].id : null };
  }

  /** 设置条目决策（accept/skip/pending）。返回受影响行数。 */
  setScanPreviewDecisions(previewId: number, keys: string[], decision: "accept" | "skip" | "pending"): number {
    if (keys.length === 0) return 0;
    const upd = this.stmt("UPDATE scan_preview_items SET decision=? WHERE preview_id=? AND item_key=?");
    const tx = this.db.transaction(() => {
      let n = 0;
      for (const k of keys) n += upd.run(decision, previewId, k).changes;
      return n;
    });
    return tx();
  }

  /** 待应用的条目：decision=accept 且尚未应用，且变化类型可应用（new/changed/missing）。 */
  scanPreviewItemsForApply(previewId: number): any[] {
    return this.stmt(
      "SELECT * FROM scan_preview_items WHERE preview_id=? AND decision='accept' AND applied=0 AND change IN ('new','changed','duplicate_suspected','missing') ORDER BY id"
    ).all(previewId) as any[];
  }

  setScanPreviewItemResult(itemId: number, applied: boolean, error: string | null): void {
    this.stmt("UPDATE scan_preview_items SET applied=?, error=? WHERE id=?").run(applied ? 1 : 0, error, itemId);
  }

  addScanPreviewErrors(previewId: number, rows: { stage: string; path?: string | null; code?: string | null; message: string }[]): void {
    if (rows.length === 0) return;
    const t = now();
    const ins = this.stmt("INSERT INTO scan_preview_errors(preview_id, at, stage, path, code, message) VALUES (?,?,?,?,?,?)");
    const tx = this.db.transaction(() => { for (const r of rows) ins.run(previewId, t, r.stage, r.path ?? null, r.code ?? null, r.message); });
    tx();
  }
  listScanPreviewErrors(previewId: number, limit = 100): any[] {
    return this.stmt("SELECT * FROM scan_preview_errors WHERE preview_id=? ORDER BY id LIMIT ?").all(previewId, Math.min(500, limit));
  }

  createScanApplyRun(input: { previewId: number; idempotencyKey?: string | null; requested: number; jobId?: number | null }): any {
    const info = this.stmt(
      "INSERT INTO scan_apply_runs(preview_id, job_id, idempotency_key, state, requested, created_at) VALUES (?,?,?,'running',?,?)"
    ).run(input.previewId, input.jobId ?? null, input.idempotencyKey ?? null, input.requested, now());
    return this.stmt("SELECT * FROM scan_apply_runs WHERE id=?").get(Number(info.lastInsertRowid));
  }
  getScanApplyRun(id: number): any { return this.stmt("SELECT * FROM scan_apply_runs WHERE id=?").get(id) ?? null; }
  listScanApplyRuns(previewId: number, limit = 20): any[] {
    return this.stmt("SELECT * FROM scan_apply_runs WHERE preview_id=? ORDER BY id DESC LIMIT ?").all(previewId, Math.min(100, limit));
  }
  findScanApplyRunByKey(previewId: number, key: string): any {
    return this.stmt("SELECT * FROM scan_apply_runs WHERE preview_id=? AND idempotency_key=?").get(previewId, key) ?? null;
  }
  updateScanApplyRun(id: number, patch: Record<string, unknown>): any {
    const allowed = ["state", "job_id", "applied", "failed", "stale", "skipped", "detail_json", "finished_at"];
    const sets: string[] = []; const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) { if (allowed.includes(k) && v !== undefined) { sets.push(k + " = ?"); params.push(v as any); } }
    if (sets.length) { params.push(id); this.stmt("UPDATE scan_apply_runs SET " + sets.join(", ") + " WHERE id=?").run(...params as any[]); }
    return this.getScanApplyRun(id);
  }

  deleteScanPreview(id: number): boolean { return this.stmt("DELETE FROM scan_previews WHERE id=?").run(id).changes > 0; }

  /**
   * CAS 更新（v0.6.1 FIX-01）：只有当前 state ∈ expectedStates 才写；未命中返回 null。
   * 预览生成/应用收尾用它写终态 —— 被用户取消/已被清扫成终态后，迟到的结果直接丢弃。
   */
  updateScanPreviewIf(id: number, expectedStates: string[], patch: Record<string, unknown>): any | null {
    const allowed = ["state", "plan_hash", "truncated", "complete", "files", "dirs", "bytes", "error_count",
      "counts_json", "scan_json", "error", "apply_job_id", "finished_at", "expires_at"];
    const sets: string[] = []; const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) { if (allowed.includes(k) && v !== undefined) { sets.push(k + " = ?"); params.push(v as any); } }
    if (!sets.length || expectedStates.length === 0) return null;
    params.push(id, ...expectedStates);
    const changes = this.stmt(
      "UPDATE scan_previews SET " + sets.join(", ") + " WHERE id=? AND state IN (" + expectedStates.map(() => "?").join(",") + ")"
    ).run(...params as any[]).changes;
    return changes === 1 ? this.getScanPreview(id) : null;
  }
  /** CAS 更新 apply run（同上）；被取消/清扫后迟到的收尾结果丢弃。 */
  updateScanApplyRunIf(id: number, expectedStates: string[], patch: Record<string, unknown>): any | null {
    const allowed = ["state", "job_id", "applied", "failed", "stale", "skipped", "detail_json", "finished_at"];
    const sets: string[] = []; const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) { if (allowed.includes(k) && v !== undefined) { sets.push(k + " = ?"); params.push(v as any); } }
    if (!sets.length || expectedStates.length === 0) return null;
    params.push(id, ...expectedStates);
    const changes = this.stmt(
      "UPDATE scan_apply_runs SET " + sets.join(", ") + " WHERE id=? AND state IN (" + expectedStates.map(() => "?").join(",") + ")"
    ).run(...params as any[]).changes;
    return changes === 1 ? this.getScanApplyRun(id) : null;
  }
  /** 作业是否仍在飞（paused 也算，用户可能恢复）。 */
  isJobActive(jobId: number | null | undefined): boolean {
    if (!jobId) return false;
    const row = this.stmt("SELECT 1 AS x FROM jobs WHERE id=? AND state IN (" + ACTIVE_JOB_STATES_SQL + ")").get(jobId);
    return !!row;
  }
  /** 按 payload.previewId 找生成中的 job（json_extract；无 JSON1 时抛错由调用方兜底）。 */
  findActiveJobByPreview(previewId: number): any {
    return this.stmt(
      "SELECT * FROM jobs WHERE json_extract(payload,'$.previewId')=? AND state IN (" + ACTIVE_JOB_STATES_SQL + ") ORDER BY id DESC LIMIT 1"
    ).get(previewId) ?? null;
  }

  /**
   * 清扫预览/应用失联状态（v0.6.1 FIX-01）。启动 + 列表/入口调用。
   * - scanning 且 expires_at 过期且无在飞生成 job → expired
   * - applying 且 apply_job_id 缺失/对应 job 非在飞 → failed（应用中断）
   * - scan_apply_runs running 且 job 缺失/非在飞 → failed
   * 同时保留旧语义：ready/partial 过期 → expired。返回受影响行数总和。
   */
  expireScanPreviews(): number {
    const at = now();
    let n = 0;
    n += this.stmt(
      "UPDATE scan_previews SET state='expired', finished_at=?, error=COALESCE(error,'扫描超时（无在飞作业）') " +
      "WHERE state='ready' AND expires_at IS NOT NULL AND expires_at < ?"
    ).run(at, at).changes;
    n += this.stmt(
      "UPDATE scan_previews SET state='expired', finished_at=?, error=COALESCE(error,'扫描超时（无在飞作业）') " +
      "WHERE state='partial' AND expires_at IS NOT NULL AND expires_at < ?"
    ).run(at, at).changes;
    n += this.stmt(
      "UPDATE scan_previews SET state='expired', finished_at=?, error=COALESCE(error,'扫描超时（无在飞作业）') " +
      "WHERE state='scanning' AND expires_at IS NOT NULL AND expires_at < ? " +
      "AND NOT EXISTS (SELECT 1 FROM jobs j WHERE json_extract(j.payload,'$.previewId')=scan_previews.id AND j.state IN (" + ACTIVE_JOB_STATES_SQL + "))"
    ).run(at, at).changes;
    n += this.stmt(
      "UPDATE scan_previews SET state='failed', finished_at=?, error=COALESCE(error,'应用中断（作业已失效）') " +
      "WHERE state='applying' AND (apply_job_id IS NULL OR NOT EXISTS (" +
      "SELECT 1 FROM jobs j WHERE j.id=scan_previews.apply_job_id AND j.state IN (" + ACTIVE_JOB_STATES_SQL + ")))"
    ).run(at).changes;
    n += this.stmt(
      "UPDATE scan_apply_runs SET state='failed', finished_at=?, detail_json=COALESCE(detail_json,'apply job dead') " +
      "WHERE state='running' AND (job_id IS NULL OR NOT EXISTS (" +
      "SELECT 1 FROM jobs j WHERE j.id=scan_apply_runs.job_id AND j.state IN (" + ACTIVE_JOB_STATES_SQL + ")))"
    ).run(at).changes;
    return n;
  }


  // ---------- 深度索引流水线（v5）----------
  // 一条 index_task = 一个资产的一个阶段；worker 用 CAS 领取，depends_on 显式声明阶段依赖。
  // 不改变 jobs 状态机：jobs 仍是顶层作业，流水线是它派生出的子任务。

  getAssetIndexSummary(): { state: string; count: number }[] {
    return this.stmt("SELECT index_state state, COUNT(*) count FROM assets WHERE status<>'trashed' GROUP BY 1").all() as any[];
  }
  setAssetIndexState(assetId: number, state: string, error: string | null = null): void {
    // FIX-03：index_error 保留首因——成功（done）才清空；后到的 null/泛化错误不覆盖已记录的具体原因。
    this.stmt(
      "UPDATE assets SET index_state=?, " +
      "index_error=CASE WHEN ?='done' THEN NULL WHEN ? IS NOT NULL AND index_error IS NULL THEN ? ELSE index_error END, " +
      "indexed_at=? WHERE id=?"
    ).run(state, state, error, error, state === "done" ? now() : null, assetId);
  }
  setAssetContentVersion(assetId: number, version: string | null): void {
    this.stmt("UPDATE assets SET content_version=? WHERE id=?").run(version, assetId);
  }

  /** 入队（幂等）：同一 asset+stage 已有活跃任务时复用，必要时提升优先级/补 depends_on。 */
  enqueueIndexTask(input: { assetId: number; itemId?: number | null; stage: string; priority?: number; maxAttempts?: number; dependsOn?: number | null; fingerprint?: string | null; versionKey?: string | null; jobId?: number | null }): number {
    // check-then-insert 必须在事务里（多进程下唯一活跃索引仍是最终防线；撞了就当已存在处理）
    const run = (): number => {
      const existing = this.stmt(
        "SELECT * FROM index_tasks WHERE asset_id=? AND stage=? AND state IN ('queued','running','waiting_retry')"
      ).get(input.assetId, input.stage) as any;
      if (existing) {
        const priority = Math.max(Number(existing.priority) || 0, input.priority ?? 0);
        if (priority !== existing.priority || (input.dependsOn && !existing.depends_on)) {
          this.stmt("UPDATE index_tasks SET priority=?, depends_on=COALESCE(depends_on, ?) WHERE id=?").run(priority, input.dependsOn ?? null, existing.id);
        }
        return Number(existing.id);
      }
      const info = this.stmt(
        "INSERT INTO index_tasks(asset_id, item_id, stage, state, priority, max_attempts, depends_on, fingerprint, version_key, job_id, created_at) VALUES (?,?,?,'queued',?,?,?,?,?,?,?)"
      ).run(input.assetId, input.itemId ?? null, input.stage, input.priority ?? 0, input.maxAttempts ?? 3, input.dependsOn ?? null, input.fingerprint ?? null, input.versionKey ?? null, input.jobId ?? null, now());
      return Number(info.lastInsertRowid);
    };
    try { return this.transactionIfNeeded(run); }
    catch (e) {
      if (String((e as any)?.code ?? "").includes("SQLITE_CONSTRAINT")) {
        const ex = this.stmt("SELECT id FROM index_tasks WHERE asset_id=? AND stage=? AND state IN ('queued','running','waiting_retry')").get(input.assetId, input.stage) as any;
        if (ex) return Number(ex.id);
      }
      throw e;
    }
  }

  /**
   * 整链入队（v0.6.1 task-17 #4）：一个事务 + 一次去重 SELECT + 按阶段名解析 depends_on，
   * 可选同事务写 assets.index_state。返回与 input.stages 同序的 task id 列表。
   * 幂等语义与 enqueueIndexTask 相同（已有活跃任务复用并合并 priority/depends_on）。
   */
  enqueueIndexTaskChain(input: {
    assetId: number; itemId?: number | null; priority?: number; maxAttempts?: number;
    fingerprint?: string | null; versionKey?: string | null;
    stages: { stage: string; dependsOnStage: string | null }[];
    assetState?: { state: string; error?: string | null } | null;
    /** v7：任务归属的顶层作业 id（reap 时按 job 重置 running 子任务）。 */
    jobId?: number | null;
  }): number[] {
    const priority = input.priority ?? 0;
    const maxAttempts = input.maxAttempts ?? 3;
    const run = (): number[] => {
      const existing = this.stmt(
        "SELECT id, stage, priority, depends_on FROM index_tasks WHERE asset_id=? AND state IN ('queued','running','waiting_retry')"
      ).all(input.assetId) as any[];
      const byStage = new Map<string, any>(existing.map((r) => [String(r.stage), r]));
      const idByStage = new Map<string, number>();
      const upd = this.stmt("UPDATE index_tasks SET priority=?, depends_on=COALESCE(depends_on, ?) WHERE id=?");
      const ins = this.stmt(
        "INSERT INTO index_tasks(asset_id, item_id, stage, state, priority, max_attempts, depends_on, fingerprint, version_key, job_id, created_at) VALUES (?,?,?,'queued',?,?,?,?,?,?,?)"
      );
      for (const s of input.stages) {
        const ex = byStage.get(s.stage);
        const depId = s.dependsOnStage
          ? (idByStage.get(s.dependsOnStage) ?? (byStage.get(s.dependsOnStage) ? Number(byStage.get(s.dependsOnStage).id) : null))
          : null;
        if (ex) {
          const mergedPriority = Math.max(Number(ex.priority) || 0, priority);
          if (mergedPriority !== Number(ex.priority) || (depId && !ex.depends_on)) upd.run(mergedPriority, depId, Number(ex.id));
          if (input.jobId && !ex.job_id) this.stmt("UPDATE index_tasks SET job_id=? WHERE id=?").run(input.jobId, Number(ex.id));
          idByStage.set(s.stage, Number(ex.id));
          continue;
        }
        const info = ins.run(input.assetId, input.itemId ?? null, s.stage, priority, maxAttempts, depId, input.fingerprint ?? null, input.versionKey ?? null, input.jobId ?? null, now());
        idByStage.set(s.stage, Number(info.lastInsertRowid));
      }
      if (input.assetState) this.setAssetIndexState(input.assetId, input.assetState.state, input.assetState.error ?? null);
      return input.stages.map((s) => idByStage.get(s.stage)!);
    };
    try { return this.transactionIfNeeded(run); }
    catch (e) {
      if (String((e as any)?.code ?? "").includes("SQLITE_CONSTRAINT")) {
        // 跨进程竞态（唯一活跃索引）：回退到逐阶段重查，与 enqueueIndexTask 的最终防线一致
        return input.stages.map((s) => {
          const ex = this.stmt("SELECT id FROM index_tasks WHERE asset_id=? AND stage=? AND state IN ('queued','running','waiting_retry')")
            .get(input.assetId, s.stage) as any;
          if (!ex) throw e;
          return Number(ex.id);
        });
      }
      throw e;
    }
  }

  getIndexTask(id: number): any { return this.stmt("SELECT * FROM index_tasks WHERE id=?").get(id) ?? null; }

  /**
   * SQLite 是否支持 UPDATE … RETURNING（v0.6.1 task-17：省掉 claim 的额外 SELECT）。
   * 首次使用前探测一次；不可用或运行时报错 → 永久回落到旧的 pick+update（不硬失败）。
   */
  private supportsReturning(): boolean {
    if (this.returningSupported !== null) return this.returningSupported;
    try { this.db.prepare("SELECT 1 AS x RETURNING x").get(); this.returningSupported = true; }
    catch { this.returningSupported = false; }
    return this.returningSupported;
  }

  /**
   * CAS 领取一条可运行任务：queued + 依赖已 done/skipped + 退避到期。
   * 返回 null 表示该阶段当前没有可领取的任务（不是错误）。
   * v0.6.1 task-17：优先单语句 UPDATE … RETURNING（语义与旧 pick+update 逐条对齐：state/attempts/
   * started_at/next_retry_at/依赖条件都不变），省掉 pick 与 getIndexTask 两次 SELECT；
   * 运行环境不支持时保留 fallback。
   */
  claimIndexTask(stage: string, owner?: string): any {
    const at = now();
    // v7：领取即写 owner + lease_token+1；pipeline 后续所有写入都用这一对做围栏。
    // 未显式传 owner 的调用（测试/诊断）仍可用，但只能走"未围栏"的 finish/retry 兼容路径。
    const who = owner ?? ("local#" + process.pid);
    if (this.supportsReturning()) {
      try {
        const row = this.db.prepare(
          `UPDATE index_tasks SET state='running', started_at=?, attempts=attempts+1, next_retry_at=NULL,
             owner=?, lease_token=lease_token+1
           WHERE id = (SELECT t.id FROM index_tasks t
              WHERE t.state='queued' AND t.stage=?
                AND (t.next_retry_at IS NULL OR t.next_retry_at <= ?)
                AND (t.depends_on IS NULL OR EXISTS (
                  SELECT 1 FROM index_tasks d WHERE d.id=t.depends_on AND d.state IN ('done','skipped')))
              ORDER BY t.priority DESC, t.id ASC LIMIT 1)
             AND state='queued'
           RETURNING *`
        ).get(at, who, stage, at);
        return row ?? null;
      } catch {
        // 运行时才暴露不支持（例如换了 SQLite 构建）：本进程永久回落
        this.returningSupported = false;
      }
    }
    const pick = this.stmt(
      `SELECT t.* FROM index_tasks t
        WHERE t.state='queued' AND t.stage=?
          AND (t.next_retry_at IS NULL OR t.next_retry_at <= ?)
          AND (t.depends_on IS NULL OR EXISTS (
            SELECT 1 FROM index_tasks d WHERE d.id=t.depends_on AND d.state IN ('done','skipped')))
        ORDER BY t.priority DESC, t.id ASC LIMIT 1`
    );
    const upd = this.stmt("UPDATE index_tasks SET state='running', started_at=?, attempts=attempts+1, next_retry_at=NULL, owner=?, lease_token=lease_token+1 WHERE id=? AND state='queued'");
    for (let i = 0; i < 8; i++) {
      const row = pick.get(stage, at) as any;
      if (!row) return null;
      const info = upd.run(at, who, row.id);
      if (info.changes === 1) return this.getIndexTask(row.id);
    }
    return null;
  }

  /**
   * 进度/诊断写入。v7：传 fence（owner+leaseToken）时带 owner+token+state='running' CAS；
   * 旧持有者 0 行 → 返回 false（不抛错，由 pipeline 记 lease_lost 诊断并丢弃本次写入）。
   */
  updateIndexTask(id: number, patch: { bytesDone?: number; bytesTotal?: number; itemsDone?: number; itemsTotal?: number; error?: string | null; errorCode?: string | null }, fence?: { owner: string; leaseToken: number }): boolean {
    const sets: string[] = []; const params: unknown[] = [];
    if (patch.bytesDone !== undefined) { sets.push("bytes_done = ?"); params.push(Math.max(0, Math.floor(patch.bytesDone))); }
    if (patch.bytesTotal !== undefined) { sets.push("bytes_total = ?"); params.push(Math.max(0, Math.floor(patch.bytesTotal))); }
    if (patch.itemsDone !== undefined) { sets.push("items_done = ?"); params.push(Math.max(0, Math.floor(patch.itemsDone))); }
    if (patch.itemsTotal !== undefined) { sets.push("items_total = ?"); params.push(Math.max(0, Math.floor(patch.itemsTotal))); }
    if (patch.error !== undefined) { sets.push("error = ?"); params.push(patch.error); }
    if (patch.errorCode !== undefined) { sets.push("error_code = ?"); params.push(patch.errorCode); }
    if (!sets.length) return true;
    params.push(id);
    let where = " WHERE id=?";
    if (fence) { where += " AND owner=? AND lease_token=? AND state='running'"; params.push(fence.owner, fence.leaseToken); }
    return this.stmt("UPDATE index_tasks SET " + sets.join(", ") + where).run(...params as any[]).changes === 1;
  }

  /** 终态：done / skipped（不适用或被限制降级）/ failed（不可重试）/ cancelled。 */
  /**
   * 终态写入。requireRunning=true 时带 CAS（WHERE state='running'）：任务被 recover/重领后，
   * 旧 worker 的迟到结果不会覆盖新终态（lost update）。
   */
  finishIndexTask(id: number, state: "done" | "skipped" | "failed" | "cancelled", detail: { errorCode?: string | null; error?: string | null } = {}, opts: { requireRunning?: boolean; owner?: string; leaseToken?: number } = {}): any {
    if (opts.owner !== undefined && opts.leaseToken !== undefined) {
      // v7 围栏：只允许"当前 owner + 当前 token + 仍在 running"的持有者写终态。
      // 0 行返回 null（不抛错）—— 旧 failed 不可能覆盖新 done，旧持有者也不可能改写新终态。
      const changes = this.stmt("UPDATE index_tasks SET state=?, finished_at=?, error_code=?, error=? WHERE id=? AND owner=? AND lease_token=? AND state='running'")
        .run(state, now(), detail.errorCode ?? null, detail.error ?? null, id, opts.owner, opts.leaseToken).changes;
      return changes === 1 ? this.getIndexTask(id) : null;
    }
    if (opts.requireRunning) {
      this.stmt("UPDATE index_tasks SET state=?, finished_at=?, error_code=?, error=? WHERE id=? AND state='running'")
        .run(state, now(), detail.errorCode ?? null, detail.error ?? null, id);
    } else {
      this.stmt("UPDATE index_tasks SET state=?, finished_at=?, error_code=?, error=? WHERE id=?")
        .run(state, now(), detail.errorCode ?? null, detail.error ?? null, id);
    }
    return this.getIndexTask(id);
  }
  /** 把退避到期的 waiting_retry 提升回 queued（worker 定时调用；否则运行期重试永远不执行）。 */
  promoteDueRetries(): number {
    return this.stmt("UPDATE index_tasks SET state='queued', started_at=NULL, next_retry_at=NULL WHERE state='waiting_retry' AND (next_retry_at IS NULL OR next_retry_at <= ?)").run(now()).changes;
  }

  /** 失败但可重试：进入 waiting_retry（attempts 已在领取时 +1，超过 max_attempts 由调用方判 failed）。 */
  retryIndexTask(id: number, detail: { errorCode?: string | null; error?: string | null; backoffMs?: number } = {}, fence?: { owner: string; leaseToken: number }): any {
    const at = new Date(Date.now() + (detail.backoffMs ?? 1000)).toISOString();
    if (fence) {
      const changes = this.stmt("UPDATE index_tasks SET state='waiting_retry', started_at=NULL, next_retry_at=?, error_code=?, error=? WHERE id=? AND owner=? AND lease_token=? AND state='running'")
        .run(at, detail.errorCode ?? null, detail.error ?? null, id, fence.owner, fence.leaseToken).changes;
      return changes === 1 ? this.getIndexTask(id) : null;
    }
    this.stmt("UPDATE index_tasks SET state='waiting_retry', started_at=NULL, next_retry_at=?, error_code=?, error=? WHERE id=?")
      .run(at, detail.errorCode ?? null, detail.error ?? null, id);
    return this.getIndexTask(id);
  }

  /** 人工重试：清掉退避与错误，重新排队（attempts 归零，给用户一次干净的重跑机会）。 */
  requeueIndexTask(id: number): any {
    this.stmt("UPDATE index_tasks SET state='queued', attempts=0, started_at=NULL, finished_at=NULL, next_retry_at=NULL, error=NULL, error_code=NULL WHERE id=?").run(id);
    return this.getIndexTask(id);
  }
  cancelIndexTask(id: number): any {
    this.stmt("UPDATE index_tasks SET state='cancelled', finished_at=? WHERE id=? AND state IN ('queued','waiting_retry')").run(now(), id);
    return this.getIndexTask(id);
  }
  cancelIndexTasksForAsset(assetId: number): number {
    return this.stmt("UPDATE index_tasks SET state='cancelled', finished_at=? WHERE asset_id=? AND state IN ('queued','waiting_retry')").run(now(), assetId).changes;
  }

  /** 启动恢复：running → queued（不增 attempts），到期 waiting_retry → queued；返回恢复条数。 */
  recoverIndexTasks(): number {
    const rows = this.stmt("SELECT id, asset_id, stage, state FROM index_tasks WHERE state='running'").all() as any[];
    const due = this.stmt("SELECT id, asset_id, stage FROM index_tasks WHERE state='waiting_retry' AND (next_retry_at IS NULL OR next_retry_at <= ?)").all(now()) as any[];
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        // v7：恢复即换租约（owner=NULL、token+1），旧 worker 若还活着，其后续写入会被围栏拒绝。
        this.stmt("UPDATE index_tasks SET state='queued', owner=NULL, lease_token=lease_token+1, started_at=NULL WHERE id=?").run(r.id);
        this.logPipelineEvent({ taskId: r.id, assetId: r.asset_id, stage: r.stage, event: "recovered", detail: "service restart (was running)" });
      }
      for (const r of due) {
        this.stmt("UPDATE index_tasks SET state='queued', started_at=NULL, next_retry_at=NULL WHERE id=?").run(r.id);
        this.logPipelineEvent({ taskId: r.id, assetId: r.asset_id, stage: r.stage, event: "recovered", detail: "retry backoff due" });
      }
    });
    tx();
    return rows.length + due.length;
  }

  /**
   * v7：顶层作业被回收（reap）时，把它名下仍在 running 的子任务退回 queued 并换租约。
   * 必须与 reap 的 jobs UPDATE 同一事务调用（reapExpiredLeases 内）；旧 worker 的写入随后被围栏。
   */
  resetRunningTasksForJob(jobId: number): number {
    return this.stmt(
      "UPDATE index_tasks SET state='queued', owner=NULL, lease_token=lease_token+1, started_at=NULL, next_retry_at=NULL " +
      "WHERE job_id=? AND state='running'"
    ).run(jobId).changes;
  }

  countIndexTasks(): { stage: string; state: string; count: number }[] {
    return this.stmt("SELECT stage, state, COUNT(*) count FROM index_tasks GROUP BY stage, state").all() as any[];
  }
  listIndexTasks(filter: { state?: string; stage?: string; assetId?: number; limit?: number } = {}): any[] {
    const where: string[] = []; const params: unknown[] = [];
    if (filter.state) { where.push("state = ?"); params.push(filter.state); }
    if (filter.stage) { where.push("stage = ?"); params.push(filter.stage); }
    if (filter.assetId) { where.push("asset_id = ?"); params.push(filter.assetId); }
    const sql = "SELECT * FROM index_tasks" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY priority DESC, id DESC LIMIT ?";
    params.push(Math.min(1000, Math.max(1, filter.limit ?? 100)));
    return this.stmt(sql).all(...params as any[]);
  }
  /** 最近失败（诊断面板）：带资产路径与阶段。 */
  recentIndexFailures(limit = 20): any[] {
    return this.stmt(
      `SELECT t.id, t.asset_id, t.item_id, t.stage, t.state, t.attempts, t.error_code, t.error, t.finished_at, a.path, a.size
         FROM index_tasks t LEFT JOIN assets a ON a.id=t.asset_id
        WHERE t.state='failed' ORDER BY t.id DESC LIMIT ?`
    ).all(Math.min(100, limit)) as any[];
  }
  /** 某资产的活跃任务（用于取消/跳转诊断）。 */
  activeIndexTasks(assetId: number): any[] {
    return this.stmt("SELECT * FROM index_tasks WHERE asset_id=? AND state IN ('queued','running','waiting_retry') ORDER BY id").all(assetId) as any[];
  }


  /** 上游失败/取消后，把直接依赖它的排队任务一并跳过（避免永久 queued 的“假等待”）。 */
  skipDependentTasks(taskId: number, code: string, error: string): number {
    return this.stmt("UPDATE index_tasks SET state='skipped', finished_at=?, error_code=?, error=? WHERE depends_on=? AND state IN ('queued','waiting_retry')")
      .run(now(), code, error, taskId).changes;
  }
  cancelDependentTasks(taskId: number): number {
    return this.stmt("UPDATE index_tasks SET state='cancelled', finished_at=? WHERE depends_on=? AND state IN ('queued','waiting_retry','running')")
      .run(now(), taskId).changes;
  }
  /** 交互式优先级提升：用户打开的包不必排在 2 万个小文件后面。 */
  boostIndexTasks(assetId: number, priority: number): number {
    return this.stmt("UPDATE index_tasks SET priority=MAX(priority, ?) WHERE asset_id=? AND state IN ('queued','waiting_retry')").run(priority, assetId).changes;
  }
  queueDepths(): { stage: string; state: string; count: number }[] { return this.countIndexTasks(); }

  /** 这些资产还有多少活跃（排队/运行/待重试）任务——作业的"有界等待"用它，分块避免变量上限。 */
  countActiveIndexTasks(assetIds: number[]): number {
    const ids = [...new Set(assetIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (ids.length === 0) return 0;
    // 固定 400 占位（末块补 0，0 不匹配任何 asset_id）→ 只有一种 SQL 文本，语句缓存不会随列表长度膨胀。
    const CHUNK = Repo.BATCH_CHUNK;
    const sql = "SELECT COUNT(*) c FROM index_tasks WHERE asset_id IN (" + "?,".repeat(CHUNK - 1) +
      "?) AND state IN ('queued','running','waiting_retry')";
    const stmt = this.stmt(sql);
    let n = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const padded = ids.slice(i, i + CHUNK);
      while (padded.length < CHUNK) padded.push(0);
      const r = stmt.get(...padded) as any;
      n += Number(r?.c ?? 0);
    }
    return n;
  }

  logPipelineEvent(e: { taskId?: number | null; assetId?: number | null; itemId?: number | null; stage?: string | null; event: string; detail?: string | null }): void {
    this.stmt("INSERT INTO pipeline_events(at, task_id, asset_id, item_id, stage, event, detail) VALUES (?,?,?,?,?,?,?)")
      .run(now(), e.taskId ?? null, e.assetId ?? null, e.itemId ?? null, e.stage ?? null, e.event, e.detail ?? null);
  }
  listPipelineEvents(limit = 100, afterId = 0): any[] {
    return this.stmt("SELECT * FROM pipeline_events WHERE id > ? ORDER BY id DESC LIMIT ?").all(afterId, Math.min(500, limit));
  }

  // ---------- 事件保留（v0.6.1 task-13） ----------
  getEventRetentionConfig(): EventRetentionConfig {
    let raw: unknown = null;
    try { raw = JSON.parse(this.getSetting("event_retention") ?? "null"); } catch { raw = null; }
    return normalizeEventRetention(raw);
  }
  getRetentionState(): EventRetentionState | null {
    try { return JSON.parse(this.getSetting("event_retention_state") ?? "null") as EventRetentionState; } catch { return null; }
  }
  setRetentionState(state: EventRetentionState): void { this.setSetting("event_retention_state", JSON.stringify(state)); }
  countJobEvents(): number { return Number((this.stmt("SELECT COUNT(*) c FROM job_events").get() as any)?.c ?? 0); }
  countPipelineEvents(): number { return Number((this.stmt("SELECT COUNT(*) c FROM pipeline_events").get() as any)?.c ?? 0); }
  /**
   * 可删的 job_events：只属于**终态作业**（done/cancelled/abandoned）。failed 可 retry、paused 由用户持有、
   * 其余在飞/待恢复状态一律保护 —— 条数上限也不得突破这条边界。
   */
  countPrunableJobEvents(cutoff?: string | null): number {
    const base = "SELECT COUNT(*) c FROM job_events e JOIN jobs j ON j.id=e.job_id WHERE j.state IN ('done','cancelled','abandoned')";
    const row = cutoff ? this.stmt(base + " AND e.at < ?").get(cutoff) : this.stmt(base).get();
    return Number((row as any)?.c ?? 0);
  }
  /** 单批删除（≤500，单语句/单事务）；cutoff 为空 = 按条数上限删除最老的可删事件。 */
  pruneJobEventsBatch(opts: { cutoff?: string | null; limit: number }): number {
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit)));
    const sql = opts.cutoff
      ? "DELETE FROM job_events WHERE id IN (SELECT e.id FROM job_events e JOIN jobs j ON j.id=e.job_id " +
        "WHERE j.state IN ('done','cancelled','abandoned') AND e.at < ? ORDER BY e.id LIMIT ?)"
      : "DELETE FROM job_events WHERE id IN (SELECT e.id FROM job_events e JOIN jobs j ON j.id=e.job_id " +
        "WHERE j.state IN ('done','cancelled','abandoned') ORDER BY e.id LIMIT ?)";
    const params: unknown[] = opts.cutoff ? [opts.cutoff, limit] : [limit];
    return this.stmt(sql).run(...params as any[]).changes;
  }
  /**
   * 可删的 pipeline_events：任务不存在/终态，且该资产名下没有活跃任务（queued/running/waiting_retry）。
   * task_id 与 asset_id 两个保护条件都满足才可删（两个 NOT EXISTS）。
   */
  countPrunablePipelineEvents(cutoff?: string | null): number {
    const base = "SELECT COUNT(*) c FROM pipeline_events e WHERE " + PRUNEVENT_PROTECT;
    const row = cutoff ? this.stmt(base + " AND e.at < ?").get(cutoff) : this.stmt(base).get();
    return Number((row as any)?.c ?? 0);
  }
  prunePipelineEventsBatch(opts: { cutoff?: string | null; limit: number }): number {
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit)));
    const sql = opts.cutoff
      ? "DELETE FROM pipeline_events WHERE id IN (SELECT e.id FROM pipeline_events e WHERE " + PRUNEVENT_PROTECT + " AND e.at < ? ORDER BY e.id LIMIT ?)"
      : "DELETE FROM pipeline_events WHERE id IN (SELECT e.id FROM pipeline_events e WHERE " + PRUNEVENT_PROTECT + " ORDER BY e.id LIMIT ?)";
    const params: unknown[] = opts.cutoff ? [opts.cutoff, limit] : [limit];
    return this.stmt(sql).run(...params as any[]).changes;
  }

  // ---------- 派生缓存（v5；v6 加 weak 弱身份标记）----------
  /** cache_entries.weak 列是否存在（老库/未迁移库降级：忽略 weak，不抛错）。按实例缓存一次。 */
  private weakColumn: boolean | null = null;
  private hasWeakCacheColumn(): boolean {
    if (this.weakColumn === null) {
      try {
        const cols = this.stmt("PRAGMA table_info(cache_entries)").all() as { name: string }[];
        this.weakColumn = cols.some((c) => c.name === "weak");
      } catch { this.weakColumn = false; }
    }
    return this.weakColumn;
  }
  getCacheEntry(key: string): any { return this.stmt("SELECT * FROM cache_entries WHERE key=?").get(key) ?? null; }
  /** weak=true 表示缓存键的身份来自 size/mtime（内容未必相同），供诊断/淘汰区分强键与弱键。 */
  upsertCacheEntry(e: { key: string; kind: string; contentSha?: string | null; versionKey: string; filePath: string; bytes: number; weak?: boolean }): void {
    if (this.hasWeakCacheColumn()) {
      this.stmt(
        `INSERT INTO cache_entries(key, kind, content_sha, version_key, file_path, bytes, hits, state, weak, created_at, last_used_at)
         VALUES (?,?,?,?,?,?,0,'ready',?,?,?)
         ON CONFLICT(key) DO UPDATE SET file_path=excluded.file_path, bytes=excluded.bytes, content_sha=excluded.content_sha,
           weak=excluded.weak, version_key=excluded.version_key, state='ready', last_used_at=excluded.last_used_at`
      ).run(e.key, e.kind, e.contentSha ?? null, e.versionKey, e.filePath, e.bytes, e.weak ? 1 : 0, now(), now());
      return;
    }
    // 降级路径：v5 表没有 weak 列（尚未跑到 v6 迁移）。缓存本身仍可用，只是丢失弱身份标记。
    this.stmt(
      `INSERT INTO cache_entries(key, kind, content_sha, version_key, file_path, bytes, hits, state, created_at, last_used_at)
       VALUES (?,?,?,?,?,?,0,'ready',?,?)
       ON CONFLICT(key) DO UPDATE SET file_path=excluded.file_path, bytes=excluded.bytes, content_sha=excluded.content_sha,
         version_key=excluded.version_key, state='ready', last_used_at=excluded.last_used_at`
    ).run(e.key, e.kind, e.contentSha ?? null, e.versionKey, e.filePath, e.bytes, now(), now());
  }
  touchCacheEntry(key: string): void { this.stmt("UPDATE cache_entries SET hits=hits+1, last_used_at=? WHERE key=?").run(now(), key); }
  deleteCacheEntry(key: string): void { this.stmt("DELETE FROM cache_entries WHERE key=?").run(key); }
  listCacheEntries(kind?: string, limit = 1000): any[] {
    if (kind) return this.stmt("SELECT * FROM cache_entries WHERE kind=? ORDER BY last_used_at DESC LIMIT ?").all(kind, limit) as any[];
    return this.stmt("SELECT * FROM cache_entries ORDER BY last_used_at DESC LIMIT ?").all(limit) as any[];
  }
  cacheStats(): { entries: number; bytes: number; hits: number } {
    const r = this.stmt("SELECT COUNT(*) entries, COALESCE(SUM(bytes),0) bytes, COALESCE(SUM(hits),0) hits FROM cache_entries WHERE state='ready'").get() as any;
    return { entries: Number(r.entries), bytes: Number(r.bytes), hits: Number(r.hits) };
  }
  oldestCacheEntries(limit: number): any[] {
    return this.stmt("SELECT * FROM cache_entries WHERE state='ready' ORDER BY last_used_at ASC, key ASC LIMIT ?").all(Math.max(1, limit)) as any[];
  }

  // ---------- 工作台辅助查询 ----------
  /**
   * item 上**已确认**的 avatar id（task-44：只有 source='manual' 或 match='confirmed' 才算 confirmed 证据；
   * source='auto' 的自动匹配不参与单元证据，避免把推测当人工确认）。
   */
  itemAvatarIds(itemId: number): number[] {
    return (this.stmt("SELECT avatar_id FROM item_avatars WHERE item_id=? AND (source='manual' OR match='confirmed') ORDER BY avatar_id")
      .all(itemId) as any[]).map((r) => Number(r.avatar_id));
  }
  /** 压缩包内可作为独立资源单元的 .unitypackage 条目（只取文件、大小写不敏感）。 */
  listUnitypackageEntries(assetId: number): { entryPath: string; size: number }[] {
    return (this.stmt("SELECT entry_path AS entryPath, entry_size AS size FROM archive_entries WHERE asset_id=? AND is_dir=0 AND lower(entry_path) LIKE '%.unitypackage' ORDER BY entry_path")
      .all(assetId) as any[]).map((r) => ({ entryPath: String(r.entryPath), size: Number(r.size) || 0 }));
  }
  /** 单包资产里的 GUID 抽样（执行后验证工程里是否真的落盘）。 */
  listUnitypackageGuids(assetId: number): string[] {
    return (this.stmt("SELECT guid FROM unitypackage_assets WHERE asset_id=? ORDER BY guid").all(assetId) as any[]).map((r) => String(r.guid));
  }
  /** 工程里是否出现某 GUID（扫描 Assets 下 .meta 文本的方式在 services/structure 做，这里只提供期望集合）。 */

  // ---------- 工作台：资源单元 / 关系 / 导入计划（v8）----------
  /** 按 asset 替换（upsert + 删除消失项）单元集。返回 rel_path → unit id。 */
  replaceAssetUnits(assetId: number, itemId: number | null, units: {
    relPath: string; format: string; kind: string; name: string; size: number; fingerprint: string | null;
    policy: string; importable: boolean; parseState: string; parseError?: string | null;
    avatars?: unknown; evidence?: unknown;
  }[]): Map<string, number> {
    const t = now();
    const up = this.stmt(
      "INSERT INTO asset_units(asset_id,item_id,rel_path,format,kind,name,size,fingerprint,policy,importable,parse_state,parse_error,avatar_json,evidence_json,created_at,updated_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(asset_id,rel_path) DO UPDATE SET item_id=excluded.item_id, format=excluded.format, kind=excluded.kind, name=excluded.name, " +
      "size=excluded.size, fingerprint=excluded.fingerprint, policy=excluded.policy, importable=excluded.importable, " +
      "parse_state=excluded.parse_state, parse_error=excluded.parse_error, avatar_json=excluded.avatar_json, evidence_json=excluded.evidence_json, updated_at=excluded.updated_at"
    );
    const out = new Map<string, number>();
    const tx = this.db.transaction(() => {
      for (const u of units) {
        up.run(assetId, itemId, u.relPath, u.format, u.kind, u.name, Math.max(0, Math.floor(u.size)), u.fingerprint,
          u.policy, u.importable ? 1 : 0, u.parseState, u.parseError ?? null,
          JSON.stringify(u.avatars ?? []), JSON.stringify(u.evidence ?? null), t, t);
      }
      const keep = units.map((u) => u.relPath);
      if (keep.length === 0) this.stmt("DELETE FROM asset_units WHERE asset_id=?").run(assetId);
      else {
        const ph = keep.map(() => "?").join(",");
        this.stmt("DELETE FROM asset_units WHERE asset_id=? AND rel_path NOT IN (" + ph + ")").run(assetId, ...keep);
      }
      const rows = this.stmt("SELECT id, rel_path FROM asset_units WHERE asset_id=?").all(assetId) as any[];
      for (const r of rows) out.set(String(r.rel_path), Number(r.id));
    });
    tx();
    return out;
  }

  replaceUnitRelations(fromUnitIds: number[], rels: { fromUnitId: number; toUnitId: number; type: string; evidence: string; confidence: string }[]): void {
    const tx = this.db.transaction(() => {
      for (const id of fromUnitIds) this.stmt("DELETE FROM unit_relations WHERE from_unit_id=?").run(id);
      const ins = this.stmt("INSERT OR IGNORE INTO unit_relations(from_unit_id,to_unit_id,type,evidence,confidence,confirmed,created_at) VALUES (?,?,?,?,?,0,?)");
      for (const r of rels) ins.run(r.fromUnitId, r.toUnitId, r.type, r.evidence, r.confidence, now());
    });
    tx();
  }

  listUnits(f: { itemId?: number; assetId?: number; avatarId?: number; policy?: string; level?: string; itemStatus?: string; limit?: number } = {}): any[] {
    const w: string[] = ["1=1"]; const p: unknown[] = [];
    if (f.itemId) { w.push("au.item_id=?"); p.push(f.itemId); }
    if (f.assetId) { w.push("au.asset_id=?"); p.push(f.assetId); }
    if (f.policy) { w.push("au.policy=?"); p.push(f.policy); }
    if (f.itemStatus) { w.push("i.status=?"); p.push(f.itemStatus); }
    if (f.avatarId) {
      w.push("EXISTS (SELECT 1 FROM json_each(au.avatar_json) je WHERE CAST(json_extract(je.value,'$.avatarId') AS INTEGER)=?)"); p.push(f.avatarId);
    }
    if (f.level) {
      w.push("EXISTS (SELECT 1 FROM json_each(au.avatar_json) je WHERE json_extract(je.value,'$.level')=?)"); p.push(f.level);
    }
    const limit = Math.min(2000, Math.max(1, Math.floor(f.limit ?? 1000)));
    return this.stmt(
      "SELECT au.*, a.path AS asset_path, a.kind AS asset_kind, a.container AS asset_container, a.size AS asset_size, " +
      "i.title AS item_title, i.status AS item_status FROM asset_units au " +
      "LEFT JOIN assets a ON a.id=au.asset_id LEFT JOIN items i ON i.id=au.item_id " +
      "WHERE " + w.join(" AND ") + " ORDER BY i.title, au.asset_id, au.rel_path LIMIT ?"
    ).all(...p as any[], limit) as any[];
  }
  getUnitsByIds(ids: number[]): any[] {
    const unique = [...new Set(ids.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (unique.length === 0) return [];
    const out: any[] = [];
    const CHUNK = 400;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const part = unique.slice(i, i + CHUNK);
      out.push(...this.stmt("SELECT * FROM asset_units WHERE id IN (" + part.map(() => "?").join(",") + ")").all(...part) as any[]);
    }
    return out;
  }

  workbenchAvatarCounts(itemId?: number): { avatar: { id: number; name: string }; counts: { confirmed: number; probable: number; unknown: number; mixed: number } }[] {
    const units = this.listUnits({ itemId, limit: 2000 });
    const map = new Map<number, { name: string; confirmed: Set<number>; probable: Set<number>; unknown: Set<number>; mixed: Set<number> }>();
    for (const u of units) {
      let avatars: any[] = [];
      try { avatars = JSON.parse(u.avatar_json ?? "[]"); } catch { avatars = []; }
      for (const a of Array.isArray(avatars) ? avatars : []) {
        const id = Number(a?.avatarId); if (!Number.isFinite(id) || id <= 0) continue;
        const rec = map.get(id) ?? { name: "", confirmed: new Set(), probable: new Set(), unknown: new Set(), mixed: new Set() };
        if (!rec.name) { const row = this.stmt("SELECT name FROM avatars WHERE id=?").get(id) as any; rec.name = String(row?.name ?? "#" + id); }
        const level = String(a?.level ?? "unknown");
        if (level === "confirmed") rec.confirmed.add(Number(u.id));
        else if (level === "probable") rec.probable.add(Number(u.id));
        else rec.unknown.add(Number(u.id));
        if (u.policy === "mixed_unitypackage") rec.mixed.add(Number(u.id));
        map.set(id, rec);
      }
    }
    return [...map.entries()].map(([id, r]) => ({ avatar: { id, name: r.name }, counts: { confirmed: r.confirmed.size, probable: r.probable.size, unknown: r.unknown.size, mixed: r.mixed.size } }))
      .sort((a, b) => (b.counts.confirmed + b.counts.probable) - (a.counts.confirmed + a.counts.probable) || a.avatar.name.localeCompare(b.avatar.name));
  }

  listUnitRelations(fromUnitIds: number[], type?: string): any[] {
    const unique = [...new Set(fromUnitIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (unique.length === 0) return [];
    const w = "r.from_unit_id IN (" + unique.map(() => "?").join(",") + ")" + (type ? " AND r.type=?" : "");
    const p: unknown[] = [...unique]; if (type) p.push(type);
    return this.stmt(
      "SELECT r.*, fu.name AS from_name, tu.name AS to_name, tu.asset_id AS to_asset_id, tu.policy AS to_policy, tu.importable AS to_importable " +
      "FROM unit_relations r JOIN asset_units fu ON fu.id=r.from_unit_id JOIN asset_units tu ON tu.id=r.to_unit_id WHERE " + w
    ).all(...p as any[]) as any[];
  }

  createImportPlan(input: { itemId: number; projectPath: string; policy?: string | null; status: string; precheck: unknown }): any {
    const info = this.stmt("INSERT INTO import_plans(item_id,project_path,policy,status,user_confirmed,precheck_json,created_at,version) VALUES (?,?,?,?,0,?,?,1)")
      .run(input.itemId, input.projectPath, input.policy ?? null, input.status, JSON.stringify(input.precheck ?? null), now());
    return this.getImportPlan(Number(info.lastInsertRowid));
  }
  getImportPlan(id: number): any { return this.stmt("SELECT * FROM import_plans WHERE id=?").get(id) ?? null; }
  listImportPlanItems(planId: number): any[] {
    return this.stmt(
      "SELECT pi.*, au.rel_path, au.kind AS unit_kind, au.name AS unit_name, au.parse_state, au.avatar_json, au.evidence_json, " +
      "a.path AS asset_path, a.kind AS asset_kind, a.container AS asset_container " +
      "FROM import_plan_items pi JOIN asset_units au ON au.id=pi.unit_id JOIN assets a ON a.id=pi.asset_id WHERE pi.plan_id=? ORDER BY pi.id"
    ).all(planId) as any[];
  }
  addImportPlanItem(input: { planId: number; unitId: number; assetId: number; path: string; policy?: string | null; fingerprint?: string | null; status?: string; error?: string | null }): any {
    const info = this.stmt("INSERT INTO import_plan_items(plan_id,unit_id,asset_id,path,policy,fingerprint,status,error) VALUES (?,?,?,?,?,?,?,?)")
      .run(input.planId, input.unitId, input.assetId, input.path, input.policy ?? null, input.fingerprint ?? null, input.status ?? "pending", input.error ?? null);
    return this.stmt("SELECT * FROM import_plan_items WHERE id=?").get(Number(info.lastInsertRowid));
  }
  updateImportPlan(id: number, patch: { status?: string; policy?: string | null; user_confirmed?: number; precheck_json?: string | null; version?: number }): any {
    const allowed = ["status", "policy", "user_confirmed", "precheck_json", "version"];
    const sets: string[] = []; const p: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) if (allowed.includes(k) && v !== undefined) { sets.push(k + " = ?"); p.push(v as any); }
    if (sets.length) { p.push(id); this.stmt("UPDATE import_plans SET " + sets.join(", ") + " WHERE id=?").run(...p as any[]); }
    return this.getImportPlan(id);
  }
  updateImportPlanItem(id: number, patch: { status?: string; error?: string | null; fingerprint?: string | null; policy?: string | null }): any {
    const allowed = ["status", "error", "fingerprint", "policy"];
    const sets: string[] = []; const p: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) if (allowed.includes(k) && v !== undefined) { sets.push(k + " = ?"); p.push(v as any); }
    if (sets.length) { p.push(id); this.stmt("UPDATE import_plan_items SET " + sets.join(", ") + " WHERE id=?").run(...p as any[]); }
    return this.stmt("SELECT * FROM import_plan_items WHERE id=?").get(id) ?? null;
  }

  createImportRun(input: { planId: number; projectId?: number | null; projectPath?: string | null }): any {
    const info = this.stmt("INSERT INTO import_runs(plan_id,project_id,project_path,status,started_at) VALUES (?,?,?,'running',?)")
      .run(input.planId, input.projectId ?? null, input.projectPath ?? null, now());
    return this.getImportRun(Number(info.lastInsertRowid));
  }
  getImportRun(id: number): any { return this.stmt("SELECT * FROM import_runs WHERE id=?").get(id) ?? null; }
  latestImportRun(planId: number): any { return this.stmt("SELECT * FROM import_runs WHERE plan_id=? ORDER BY id DESC LIMIT 1").get(planId) ?? null; }
  /** 同一计划是否已有在跑的 import job（plan+kind 防重复；ux_jobs_inflight 只按 item+kind）。 */
  findInflightImportJob(planId: number): any {
    return this.stmt("SELECT * FROM jobs WHERE kind='import' AND json_extract(payload,'$.planId')=? AND state IN (" + ACTIVE_JOB_STATES_SQL + ") ORDER BY id DESC LIMIT 1").get(planId) ?? null;
  }
  updateImportRun(id: number, patch: { status?: string; finished_at?: string | null; console_errors?: string | null; summary_json?: string | null; project_id?: number | null }): any {
    const allowed = ["status", "finished_at", "console_errors", "summary_json", "project_id"];
    const sets: string[] = []; const p: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) if (allowed.includes(k) && v !== undefined) { sets.push(k + " = ?"); p.push(v as any); }
    if (sets.length) { p.push(id); this.stmt("UPDATE import_runs SET " + sets.join(", ") + " WHERE id=?").run(...p as any[]); }
    return this.getImportRun(id);
  }
  addImportRunItem(input: { runId: number; planItemId: number; unitId: number }): any {
    const info = this.stmt("INSERT INTO import_run_items(run_id,plan_item_id,unit_id,status) VALUES (?,?,?,'pending')")
      .run(input.runId, input.planItemId, input.unitId);
    return this.stmt("SELECT * FROM import_run_items WHERE id=?").get(Number(info.lastInsertRowid));
  }
  listImportRunItems(runId: number): any[] {
    return this.stmt(
      "SELECT ri.*, pi.path, pi.policy, pi.unit_id AS plan_unit_id, au.name AS unit_name, au.rel_path " +
      "FROM import_run_items ri JOIN import_plan_items pi ON pi.id=ri.plan_item_id JOIN asset_units au ON au.id=ri.unit_id WHERE ri.run_id=? ORDER BY ri.id"
    ).all(runId) as any[];
  }
  updateImportRunItem(id: number, patch: { status?: string; started_at?: string | null; finished_at?: string | null; error?: string | null; detail_json?: string | null }): any {
    const allowed = ["status", "started_at", "finished_at", "error", "detail_json"];
    const sets: string[] = []; const p: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) if (allowed.includes(k) && v !== undefined) { sets.push(k + " = ?"); p.push(v as any); }
    if (sets.length) { p.push(id); this.stmt("UPDATE import_run_items SET " + sets.join(", ") + " WHERE id=?").run(...p as any[]); }
    return this.stmt("SELECT * FROM import_run_items WHERE id=?").get(id) ?? null;
  }

  // ---------- stats / export ----------
  stats(): StatsShape {
    const one = (sql: string) => (this.stmt(sql).get() as any).v as number;
    return {
      items: one("SELECT COUNT(*) v FROM items WHERE status<>'trashed'"),
      assets: one("SELECT COUNT(*) v FROM assets WHERE status<>'trashed'"),
      bytes: one("SELECT COALESCE(SUM(size),0) v FROM assets WHERE status<>'trashed'"),
      avatars: one("SELECT COUNT(*) v FROM avatars"),
      inbox: one("SELECT COUNT(*) v FROM items WHERE status='inbox'"),
      missing: one("SELECT COUNT(*) v FROM assets WHERE status='missing'"),
      byCategory: this.stmt("SELECT COALESCE(category_name,'(未分类)') name, COUNT(*) count FROM items WHERE status<>'trashed' GROUP BY 1 ORDER BY count DESC LIMIT 40").all() as any[],
      byAvatar: this.stmt("SELECT a.id, a.name, COUNT(ia.item_id) count FROM avatars a JOIN item_avatars ia ON ia.avatar_id=a.id JOIN items i ON i.id=ia.item_id AND i.status<>'trashed' GROUP BY a.id ORDER BY count DESC LIMIT 60").all() as any[],
    };
  }
  exportItems(): any[] { return this.stmt("SELECT * FROM items ORDER BY id").all(); }

  // ---------- settings ----------
  getSetting(key: string): string | null { const r = this.stmt("SELECT value FROM settings WHERE key=?").get(key) as any; return r?.value ?? null; }
  setSetting(key: string, value: string): void { this.stmt("INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
}
