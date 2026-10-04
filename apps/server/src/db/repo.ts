import type Database from "better-sqlite3";
import { now, uid, ftsPhrase } from "../util";
import { normalizePath } from "../../../../packages/core/src/pathnorm";
import { normKey, type AssetRow, type AvatarAliasRow, type AvatarKind, type AvatarMatch, type AvatarRow, type ImageOrigin, type ImageRole, type ImageRow, type ItemCard, type ItemDetail, type ItemRow, type ItemStatus, type JobEvent, type JobKind, type JobRow, type JobState, type RootMode, type SourceSite, type UpdateKind } from "../../../../packages/core/src/contracts";
import { resolveTransition } from "../../../../packages/core/src/contracts";

export interface ItemQuery {
  q?: string; avatarIds?: number[]; avatarMatch?: "any" | "all"; ownedOnly?: boolean;
  site?: string; status?: string; tag?: string; container?: string;
  sort?: "updated" | "title" | "size"; limit?: number; offset?: number; includeTrashed?: boolean; imported?: boolean; collectionId?: number;
}
export interface AvatarCard extends AvatarRow { itemCount: number; aliases: string[]; ownedBool: boolean }
export interface StatsShape {
  items: number; assets: number; bytes: number; avatars: number; inbox: number; missing: number;
  byCategory: { name: string; count: number }[]; byAvatar: { id: number; name: string; count: number }[];
}

export class Repo {
  constructor(private db: Database.Database) {}

  // ---------- roots ----------
  listRoots() { return this.db.prepare("SELECT * FROM library_roots ORDER BY id").all(); }
  getRootByPathNorm(p: string) { return this.db.prepare("SELECT * FROM library_roots WHERE path_norm = ?").get(p) as any; }
  ensureRoot(path: string, mode: RootMode = "index_in_place") {
    const pn = normalizePath(path);
    const existing = this.getRootByPathNorm(pn);
    if (existing) return existing;
    const info = this.db.prepare("INSERT INTO library_roots(path, path_norm, mode, enabled, created_at) VALUES (?,?,?,1,?)").run(path, pn, mode, now());
    return this.db.prepare("SELECT * FROM library_roots WHERE id = ?").get(info.lastInsertRowid) as any;
  }
  removeRoot(id: number) { this.db.prepare("DELETE FROM library_roots WHERE id = ?").run(id); }

  // ---------- items ----------
  private buildWhere(q: ItemQuery): { sql: string; params: unknown[] } {
    const w: string[] = []; const params: unknown[] = [];
    if (!q.includeTrashed && q.status !== "trashed") w.push("i.status <> 'trashed'");
    if (q.status) { w.push("i.status = ?"); params.push(q.status); }
    if (q.site) { w.push("i.source_site = ?"); params.push(q.site); }
    const text = (q.q ?? "").trim();
    if (text) {
      if (text.length >= 3) { w.push("i.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)"); params.push(ftsPhrase(text)); }
      else { w.push("(i.title LIKE ? OR IFNULL(i.shop_name,'') LIKE ? OR IFNULL(i.author,'') LIKE ? OR IFNULL(i.notes,'') LIKE ?)"); const l = `%${text}%`; params.push(l, l, l, l); }
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
    };
  }

  listItems(q: ItemQuery): { total: number; items: ItemCard[] } {
    const { sql: where, params } = this.buildWhere(q);
    const limit = Math.min(500, Math.max(1, q.limit ?? 60));
    const offset = Math.max(0, q.offset ?? 0);
    const order = q.sort === "title" ? "i.title COLLATE NOCASE ASC" : q.sort === "size" ? "total_bytes DESC" : "i.updated_at DESC";
    const total = (this.db.prepare(`SELECT COUNT(*) c FROM items i${where}`).get(...params as any[]) as any).c as number;
    const rows = this.db.prepare(`
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
    const rows = this.db.prepare(`SELECT ia.item_id, av.id, av.name, ia.match FROM item_avatars ia JOIN avatars av ON av.id=ia.avatar_id WHERE ia.item_id IN (${ph}) ORDER BY av.sort, av.name`).all(...ids) as any[];
    for (const r of rows) { const a = m.get(r.item_id) ?? []; a.push({ id: r.id, name: r.name, match: r.match }); m.set(r.item_id, a); }
    return m;
  }
  private itemTagsFor(ids: number[]): Map<number, string[]> {
    const m = new Map<number, string[]>();
    if (ids.length === 0) return m;
    const ph = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT it.item_id, t.name, t.namespace FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id IN (${ph})`).all(...ids) as any[];
    for (const r of rows) { const a = m.get(r.item_id) ?? []; a.push(r.namespace ? `${r.namespace}:${r.name}` : r.name); m.set(r.item_id, a); }
    return m;
  }

  getItem(id: number): ItemDetail | null {
    const r = this.db.prepare(`SELECT i.*,
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
    const avatars = (this.db.prepare(`SELECT av.id, av.name, ia.match, ia.confidence, ia.evidence, ia.source
        FROM item_avatars ia JOIN avatars av ON av.id = ia.avatar_id WHERE ia.item_id = ? ORDER BY av.sort, av.name`).all(id) as any[])
      .map((a) => ({ id: a.id, name: a.name, match: a.match, confidence: a.confidence, evidence: a.evidence, source: a.source }));
    const tags = this.itemTagsFor([id]).get(id) ?? [];
    const card = this.toCard(r, avatars, tags);
    const collections = this.collectionsOfItem(id);
    return { ...card, item: r as ItemRow, images, assets, notes: r.notes ?? null, description: r.description ?? null, collections };
  }

  getItemBySource(site: SourceSite, sourceItemId: string): ItemRow | null {
    return (this.db.prepare("SELECT * FROM items WHERE source_site = ? AND source_item_id = ?").get(site, sourceItemId) as ItemRow) ?? null;
  }

  createItem(input: Partial<ItemRow> & { title: string }): ItemRow {
    const t = now();
    const info = this.db.prepare(`INSERT INTO items(uid, source_site, source_item_id, source_url, canonical_url, title, title_ja, shop_name, shop_subdomain,
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
    const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(info.lastInsertRowid) as ItemRow;
    this.syncFts(row.id);
    return row;
  }

  updateItem(id: number, patch: Record<string, unknown>): ItemRow {
    const allowed = ["title", "title_ja", "shop_name", "shop_subdomain", "author", "price_text", "price_yen", "purchased", "published_at",
      "category_name", "category_parent", "description", "adult", "status", "rating", "favorite", "notes", "cover_image_id",
      "compat_declared_count", "id_confidence", "id_match_method", "source_url", "canonical_url", "source_item_id", "source_site", "source_gone", "last_checked_at"];
    const sets: string[] = []; const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) { if (allowed.includes(k) && v !== undefined) { sets.push(`${k} = ?`); params.push(v as any); } }
    if (sets.length === 0) return this.db.prepare("SELECT * FROM items WHERE id=?").get(id) as ItemRow;
    sets.push("updated_at = ?"); params.push(now(), id);
    this.db.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ?`).run(...params as any[]);
    this.syncFts(id);
    return this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow;
  }

  /** FTS 与 tags_text 同步（幂等）。 */
  syncFts(itemId: number): void {
    const r = this.db.prepare("SELECT title, shop_name, author, description, notes FROM items WHERE id = ?").get(itemId) as any;
    if (!r) return;
    const tags = this.itemTagsFor([itemId]).get(itemId) ?? [];
    this.db.prepare("DELETE FROM items_fts WHERE rowid = ?").run(itemId);
    this.db.prepare("INSERT INTO items_fts(rowid, title, shop_name, author, description, notes, tags_text) VALUES (?,?,?,?,?,?,?)")
      .run(itemId, r.title ?? "", r.shop_name ?? "", r.author ?? "", r.description ?? "", r.notes ?? "", tags.join(" "));
  }

  // ---------- images ----------
  listImages(itemId: number): ImageRow[] {
    return this.db.prepare("SELECT * FROM item_images WHERE item_id = ? ORDER BY position, id").all(itemId) as ImageRow[];
  }
  getImage(id: number): ImageRow | null { return (this.db.prepare("SELECT * FROM item_images WHERE id=?").get(id) as ImageRow) ?? null; }
  addImage(itemId: number, input: Partial<ImageRow> & { role: ImageRole; origin: ImageOrigin }): ImageRow {
    const pos = (this.db.prepare("SELECT COALESCE(MAX(position),-1)+1 p FROM item_images WHERE item_id=?").get(itemId) as any).p as number;
    const info = this.db.prepare(`INSERT INTO item_images(item_id, role, origin, source_url, file_path, thumb_path, width, height, bytes, sha256, position, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(itemId, input.role, input.origin, input.source_url ?? null, input.file_path ?? null,
      input.thumb_path ?? null, input.width ?? null, input.height ?? null, input.bytes ?? null, input.sha256 ?? null, input.position ?? pos, now());
    const img = this.db.prepare("SELECT * FROM item_images WHERE id=?").get(info.lastInsertRowid) as ImageRow;
    const hasCover = (this.db.prepare("SELECT cover_image_id FROM items WHERE id=?").get(itemId) as any)?.cover_image_id ?? null;
    if (input.role === "cover" || hasCover === null) this.setCover(itemId, img.id);
    return img;
  }
  deleteImage(itemId: number, imageId: number): void {
    this.db.prepare("UPDATE items SET cover_image_id = NULL WHERE id = ? AND cover_image_id = ?").run(itemId, imageId);
    this.db.prepare("DELETE FROM item_images WHERE id = ? AND item_id = ?").run(imageId, itemId);
  }
  setCover(itemId: number, imageId: number): void { this.db.prepare("UPDATE items SET cover_image_id=?, updated_at=? WHERE id=?").run(imageId, now(), itemId); }
  /** 历史修复：有图但 cover_image_id 为空的条目，取第一张图当封面。 */
  fixMissingCovers(): { fixed: number } {
    const rows = this.db.prepare(`SELECT i.id AS item_id, (SELECT id FROM item_images im WHERE im.item_id=i.id ORDER BY im.position, im.id LIMIT 1) AS img
      FROM items i WHERE i.cover_image_id IS NULL`).all() as any[];
    let fixed = 0;
    const tx = this.db.transaction(() => {
      for (const r of rows) { if (r.img) { this.db.prepare("UPDATE items SET cover_image_id=? WHERE id=?").run(r.img, r.item_id); fixed++; } }
    });
    tx();
    return { fixed };
  }

  // ---------- assets ----------
  listAssets(itemId: number): AssetRow[] { return this.db.prepare("SELECT * FROM assets WHERE item_id=? AND status<>'trashed' ORDER BY size DESC, id").all(itemId) as AssetRow[]; }
  getAsset(id: number): AssetRow | null { return (this.db.prepare("SELECT * FROM assets WHERE id=?").get(id) as AssetRow) ?? null; }
  getAssetByPathNorm(p: string): AssetRow | null { return (this.db.prepare("SELECT * FROM assets WHERE path_norm=?").get(p) as AssetRow) ?? null; }
  upsertAsset(input: { item_id: number; kind: AssetRow["kind"]; container: AssetRow["container"]; path: string; path_norm: string; root_id: number; size: number; mtime?: string | null; discovered_by: AssetRow["discovered_by"] }): { asset: AssetRow; created: boolean } {
    const existing = this.getAssetByPathNorm(input.path_norm);
    if (existing) {
      this.db.prepare("UPDATE assets SET item_id=?, size=?, mtime=?, status='present', last_verified_at=? WHERE id=?")
        .run(input.item_id, input.size, input.mtime ?? null, now(), existing.id);
      return { asset: this.getAsset(existing.id)!, created: false };
    }
    const info = this.db.prepare(`INSERT INTO assets(item_id, kind, container, path, path_norm, root_id, size, mtime, sha256_state, status, discovered_by, first_seen)
      VALUES (?,?,?,?,?,?,?,?, 'pending', 'present', ?, ?)`).run(input.item_id, input.kind, input.container, input.path, input.path_norm, input.root_id, input.size, input.mtime ?? null, input.discovered_by, now());
    return { asset: this.getAsset(Number(info.lastInsertRowid))!, created: true };
  }
  listPresentAssetsUnderPath(prefixNorm: string): { id: number; path: string; path_norm: string }[] {
    return this.db.prepare("SELECT id, path, path_norm FROM assets WHERE status='present' AND path_norm LIKE ? || '%'").all(prefixNorm) as any[];
  }
  /**
   * 合并条目：把 source 的资产/图片/模型/标签/更新历史/导入登记迁到 target，source 软删（可恢复）。
   * 用于"同一商品的模型包 + 材质包分两个压缩包"这种应当算一条素材的情况。
   */
  mergeItems(sourceId: number, targetId: number): { movedAssets: number; movedImages: number; targetId: number } {
    if (sourceId === targetId) throw Object.assign(new Error("不能合并到自己"), { code: "INVALID_INPUT", status: 400 });
    const src = this.db.prepare("SELECT * FROM items WHERE id=?").get(sourceId) as any;
    const tgt = this.db.prepare("SELECT * FROM items WHERE id=?").get(targetId) as any;
    if (!src || !tgt) throw Object.assign(new Error("条目不存在"), { code: "NOT_FOUND", status: 404 });
    const now2 = now();
    const tx = this.db.transaction(() => {
      const movedAssets = this.db.prepare("UPDATE assets SET item_id=? WHERE item_id=?").run(targetId, sourceId).changes;
      const movedImages = this.db.prepare("UPDATE item_images SET item_id=? WHERE item_id=?").run(targetId, sourceId).changes;
      // 目标没有封面时，借用来源的封面
      if (!tgt.cover_image_id && src.cover_image_id) {
        this.db.prepare("UPDATE items SET cover_image_id=? WHERE id=?").run(src.cover_image_id, targetId);
      } else if (!tgt.cover_image_id) {
        const first = this.db.prepare("SELECT id FROM item_images WHERE item_id=? ORDER BY position, id LIMIT 1").get(targetId) as any;
        if (first) this.db.prepare("UPDATE items SET cover_image_id=? WHERE id=?").run(first.id, targetId);
      }
      this.db.prepare("UPDATE item_images SET position = position + 1000 WHERE item_id=?").run(targetId);
      this.db.prepare("UPDATE item_images SET position = position - 1000 WHERE item_id=? AND position >= 1000").run(targetId);
      // 模型关联：并集，人工/已确认优先
      const srcAv = this.db.prepare("SELECT * FROM item_avatars WHERE item_id=?").all(sourceId) as any[];
      for (const a of srcAv) {
        const cur = this.db.prepare("SELECT source FROM item_avatars WHERE item_id=? AND avatar_id=?").get(targetId, a.avatar_id) as any;
        if (!cur) this.db.prepare("INSERT INTO item_avatars(item_id, avatar_id, match, confidence, evidence, source) VALUES (?,?,?,?,?,?)")
          .run(targetId, a.avatar_id, a.match, a.confidence, a.evidence, a.source);
        else if (cur.source === "auto" && a.source !== "auto") this.db.prepare("UPDATE item_avatars SET source=?, confidence=?, evidence=? WHERE item_id=? AND avatar_id=?")
          .run(a.source, a.confidence, a.evidence, targetId, a.avatar_id);
      }
      this.db.prepare("DELETE FROM item_avatars WHERE item_id=?").run(sourceId);
      // 标签并集
      const srcTags = this.db.prepare("SELECT tag_id, source FROM item_tags WHERE item_id=?").all(sourceId) as any[];
      for (const t of srcTags) this.db.prepare("INSERT OR IGNORE INTO item_tags(item_id, tag_id, source) VALUES (?,?,?)").run(targetId, t.tag_id, t.source);
      this.db.prepare("DELETE FROM item_tags WHERE item_id=?").run(sourceId);
      // 更新历史 / 快照 / 已导入登记
      this.db.prepare("UPDATE updates SET item_id=? WHERE item_id=?").run(targetId, sourceId);
      this.db.prepare("UPDATE source_snapshots SET item_id=? WHERE item_id=?").run(targetId, sourceId);
      this.db.prepare("UPDATE OR IGNORE project_imports SET item_id=? WHERE item_id=?").run(targetId, sourceId);
      this.db.prepare("DELETE FROM project_imports WHERE item_id=?").run(sourceId);
      // 来源信息：目标没有 BOOTH 号而来源有 → 继承
      const patch: any = { status: "trashed", notes: "已合并到 #" + targetId + "《" + tgt.title + "》" };
      const tgtSets: string[] = []; const tgtVals: unknown[] = [];
      if (!tgt.source_item_id && src.source_item_id) {
        for (const k of ["source_site", "source_item_id", "source_url", "canonical_url", "shop_name", "shop_subdomain", "author", "price_text", "price_yen", "category_name", "category_parent"]) {
          if (src[k] !== null && src[k] !== undefined && (tgt[k] === null || tgt[k] === undefined)) { tgtSets.push(k + " = ?"); tgtVals.push(src[k]); }
        }
      }
      if (tgtSets.length) { tgtSets.push("updated_at = ?"); tgtVals.push(now2, targetId); this.db.prepare("UPDATE items SET " + tgtSets.join(", ") + " WHERE id=?").run(...tgtVals as any[]); }
      else this.db.prepare("UPDATE items SET updated_at=? WHERE id=?").run(now2, targetId);
      const sets = Object.entries(patch).map(([k]) => k + " = ?");
      this.db.prepare("UPDATE items SET " + sets.join(", ") + ", updated_at=? WHERE id=?").run(...Object.values(patch) as any[], now2, sourceId);
      return { movedAssets, movedImages, targetId };
    });
    const r = tx();
    this.syncFts(targetId);
    this.syncFts(sourceId);
    return r;
  }

  /** 把某条目的资产整体挪到另一条目（用于"本地条目关联 BOOTH 商品后发现重复"的合并）。 */
  moveAssets(fromItemId: number, toItemId: number): number {
    const r = this.db.prepare("UPDATE assets SET item_id = ? WHERE item_id = ?").run(toItemId, fromItemId);
    return r.changes;
  }
  markAssetsMissing(ids: number[]): void {
    if (ids.length === 0) return;
    const ph = ids.map(() => "?").join(",");
    this.db.prepare(`UPDATE assets SET status='missing' WHERE id IN (${ph})`).run(...ids);
  }
  touchAsset(id: number): void { this.db.prepare("UPDATE assets SET last_verified_at=? WHERE id=?").run(now(), id); }
  setAssetSha(id: number, sha: string | null, state: "ok" | "error"): void { this.db.prepare("UPDATE assets SET sha256=?, sha256_state=? WHERE id=?").run(sha, state, id); }

  replaceArchiveEntries(assetId: number, entries: { path: string; size: number; isDir: boolean; ext?: string | null }[]): void {
    const tx = this.db.transaction((rows: typeof entries) => {
      this.db.prepare("DELETE FROM archive_entries WHERE asset_id=?").run(assetId);
      const ins = this.db.prepare("INSERT OR IGNORE INTO archive_entries(asset_id, entry_path, entry_size, is_dir, ext) VALUES (?,?,?,?,?)");
      for (const e of rows) ins.run(assetId, e.path, e.size ?? 0, e.isDir ? 1 : 0, e.ext ?? null);
    });
    tx(entries);
  }
  getArchiveEntries(assetId: number) { return this.db.prepare("SELECT entry_path AS path, entry_size AS size, is_dir AS isDir, ext FROM archive_entries WHERE asset_id=? ORDER BY entry_path").all(assetId) as any[]; }
  countArchiveEntries(assetId: number): number { return (this.db.prepare("SELECT COUNT(*) c FROM archive_entries WHERE asset_id=?").get(assetId) as any).c; }

  replaceUnityPackageAssets(assetId: number, assets: { guid: string; assetPath: string; type: string | null; size: number | null; hasPreview: boolean }[]): void {
    const tx = this.db.transaction((rows: typeof assets) => {
      this.db.prepare("DELETE FROM unitypackage_assets WHERE asset_id=?").run(assetId);
      const ins = this.db.prepare("INSERT OR IGNORE INTO unitypackage_assets(asset_id, guid, asset_path, type, size, has_preview) VALUES (?,?,?,?,?,?)");
      for (const a of rows) ins.run(assetId, a.guid, a.assetPath, a.type, a.size, a.hasPreview ? 1 : 0);
    });
    tx(assets);
  }
  getUnityPackageAssets(assetId: number) { return this.db.prepare("SELECT guid, asset_path AS assetPath, type, size, has_preview AS hasPreview FROM unitypackage_assets WHERE asset_id=? ORDER BY asset_path").all(assetId) as any[]; }

  // ---------- avatars ----------
  listAvatars(q: { ownedOnly?: boolean; q?: string } = {}): AvatarCard[] {
    const w: string[] = []; const params: unknown[] = [];
    if (q.ownedOnly) w.push("a.owned = 1");
    if (q.q) { w.push("(a.name LIKE ? OR a.name_norm LIKE ? OR EXISTS(SELECT 1 FROM avatar_aliases al WHERE al.avatar_id=a.id AND (al.alias LIKE ? OR al.alias_norm LIKE ?)))"); const l = `%${q.q}%`; const ln = `%${normKey(q.q)}%`; params.push(l, ln, l, ln); }
    const where = w.length ? " WHERE " + w.join(" AND ") : "";
    const rows = this.db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM item_avatars ia JOIN items i ON i.id=ia.item_id WHERE ia.avatar_id=a.id AND ia.match<>'exclude' AND i.status<>'trashed') AS item_count
      FROM avatars a${where} ORDER BY a.sort, a.name`).all(...params as any[]) as any[];
    const aliasRows = this.db.prepare("SELECT avatar_id, alias FROM avatar_aliases ORDER BY id").all() as any[];
    const byAvatar = new Map<number, string[]>();
    for (const r of aliasRows) { const l = byAvatar.get(r.avatar_id) ?? []; l.push(r.alias); byAvatar.set(r.avatar_id, l); }
    return rows.map((r) => ({ ...r, ownedBool: r.owned === 1, itemCount: r.item_count ?? 0, aliases: byAvatar.get(r.id) ?? [] })) as AvatarCard[];
  }
  getAvatar(id: number): AvatarRow | null { return (this.db.prepare("SELECT * FROM avatars WHERE id=?").get(id) as AvatarRow) ?? null; }
  findAvatarByAlias(normalized: string): AvatarRow | null {
    return (this.db.prepare("SELECT a.* FROM avatars a JOIN avatar_aliases al ON al.avatar_id=a.id WHERE al.alias_norm=?").get(normalized) as AvatarRow)
      ?? (this.db.prepare("SELECT * FROM avatars WHERE name_norm=?").get(normalized) as AvatarRow) ?? null;
  }
  createAvatar(input: { name: string; kind?: AvatarKind; owned?: boolean; boothItemId?: string | null; aliases?: string[] }): AvatarRow {
    const t = now(); const nn = normKey(input.name);
    const info = this.db.prepare("INSERT INTO avatars(name, name_norm, kind, booth_item_id, owned, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(input.name, nn, input.kind ?? "avatar", input.boothItemId ?? null, input.owned ? 1 : 0, 0, t, t);
    const id = Number(info.lastInsertRowid);
    const addAlias = this.db.prepare("INSERT INTO avatar_aliases(avatar_id, alias, alias_norm, lang, source) VALUES (?,?,?,?,?)");
    for (const a of input.aliases ?? []) { try { addAlias.run(id, a, normKey(a), null, "seed"); } catch { /* 别名冲突：跳过，路由层会报告 */ } }
    return this.getAvatar(id)!;
  }
  updateAvatar(id: number, patch: Partial<AvatarRow>): AvatarRow {
    const allowed = ["name", "kind", "booth_item_id", "cover_path", "owned", "sort"];
    const sets: string[] = []; const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) { if (allowed.includes(k) && v !== undefined) { sets.push(`${k} = ?`); params.push(v as any); } }
    if (patch.name !== undefined) { sets.push("name_norm = ?"); params.push(normKey(String(patch.name))); }
    if (sets.length) { sets.push("updated_at = ?"); params.push(now(), id); this.db.prepare(`UPDATE avatars SET ${sets.join(", ")} WHERE id=?`).run(...params as any[]); }
    return this.getAvatar(id)!;
  }
  deleteAvatar(id: number): void { this.db.prepare("DELETE FROM avatars WHERE id=?").run(id); }
  listAliases(avatarId: number): AvatarAliasRow[] { return this.db.prepare("SELECT * FROM avatar_aliases WHERE avatar_id=? ORDER BY id").all(avatarId) as AvatarAliasRow[]; }
  addAlias(avatarId: number, alias: string, lang: string | null, source: AvatarAliasRow["source"]): AvatarAliasRow {
    const info = this.db.prepare("INSERT INTO avatar_aliases(avatar_id, alias, alias_norm, lang, source) VALUES (?,?,?,?,?)").run(avatarId, alias, normKey(alias), lang, source);
    return this.db.prepare("SELECT * FROM avatar_aliases WHERE id=?").get(info.lastInsertRowid) as AvatarAliasRow;
  }
  deleteAlias(avatarId: number, aliasId: number): void { this.db.prepare("DELETE FROM avatar_aliases WHERE id=? AND avatar_id=?").run(aliasId, avatarId); }
  mergeAvatars(fromId: number, intoId: number): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE OR IGNORE item_avatars SET avatar_id=? WHERE avatar_id=?").run(intoId, fromId);
      this.db.prepare("DELETE FROM item_avatars WHERE avatar_id=?").run(fromId);
      this.db.prepare("UPDATE OR IGNORE asset_avatars SET avatar_id=? WHERE avatar_id=?").run(intoId, fromId);
      this.db.prepare("DELETE FROM asset_avatars WHERE avatar_id=?").run(fromId);
      this.db.prepare("UPDATE OR IGNORE avatar_aliases SET avatar_id=? WHERE avatar_id=?").run(intoId, fromId);
      this.db.prepare("DELETE FROM avatar_aliases WHERE avatar_id=?").run(fromId);
      this.db.prepare("DELETE FROM avatars WHERE id=?").run(fromId);
      this.db.prepare("UPDATE avatars SET updated_at=? WHERE id=?").run(now(), intoId);
    });
    tx();
  }
  setItemAvatars(itemId: number, ids: number[], source: "auto" | "manual" | "confirmed", match: AvatarMatch = "any", confidence = 1, evidence: string | null = null): void {
    const tx = this.db.transaction(() => {
      const ins = this.db.prepare(`INSERT INTO item_avatars(item_id, avatar_id, match, confidence, evidence, source) VALUES (?,?,?,?,?,?)
        ON CONFLICT(item_id, avatar_id) DO UPDATE SET match=excluded.match, confidence=excluded.confidence, evidence=COALESCE(excluded.evidence, item_avatars.evidence), source=excluded.source`);
      for (const id of ids) ins.run(itemId, id, match, confidence, evidence, source);
    });
    tx();
  }
  removeItemAvatar(itemId: number, avatarId: number): void { this.db.prepare("DELETE FROM item_avatars WHERE item_id=? AND avatar_id=?").run(itemId, avatarId); }
  listItemAvatars(itemId: number) { return this.db.prepare("SELECT ia.*, a.name, a.name_norm FROM item_avatars ia JOIN avatars a ON a.id=ia.avatar_id WHERE ia.item_id=? ORDER BY a.name").all(itemId) as any[]; }
  setAssetAvatar(assetId: number, avatarId: number, entryPrefix: string | null, confidence: number, evidence: string | null): void {
    this.db.prepare(`INSERT INTO asset_avatars(asset_id, avatar_id, entry_prefix, confidence, evidence) VALUES (?,?,?,?,?)
      ON CONFLICT(asset_id, avatar_id, IFNULL(entry_prefix,'')) DO UPDATE SET confidence=excluded.confidence, evidence=excluded.evidence`)
      .run(assetId, avatarId, entryPrefix, confidence, evidence);
  }
  listAssetAvatars(assetId: number) { return this.db.prepare("SELECT aa.*, a.name FROM asset_avatars aa JOIN avatars a ON a.id=aa.avatar_id WHERE aa.asset_id=? ORDER BY a.name").all(assetId) as any[]; }

  // ---------- tags ----------
  listTags() { return this.db.prepare("SELECT t.*, (SELECT COUNT(*) FROM item_tags it WHERE it.tag_id=t.id) AS itemCount FROM tags t ORDER BY t.namespace, t.name").all(); }
  ensureTag(name: string, namespace: string | null = null, color: string | null = null): number {
    const existing = this.db.prepare("SELECT id FROM tags WHERE IFNULL(namespace,'') = IFNULL(?,'') AND name = ?").get(namespace, name) as any;
    if (existing) return existing.id;
    return Number(this.db.prepare("INSERT INTO tags(name, namespace, color, sort) VALUES (?,?,?,0)").run(name, namespace, color).lastInsertRowid);
  }
  /** 全量替换条目标签（UI 的标签编辑用；自动标签也一并由传入列表决定）。 */
  setItemTags(itemId: number, names: string[], source: "auto" | "manual"): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM item_tags WHERE item_id = ?").run(itemId);
      const ins = this.db.prepare("INSERT OR IGNORE INTO item_tags(item_id, tag_id, source) VALUES (?,?,?)");
      for (const n of names) { if (!n?.trim()) continue; ins.run(itemId, this.ensureTag(n.trim()), source); }
    });
    tx();
    this.syncFts(itemId);
  }
  reorderImages(itemId: number, imageIds: number[]): void {
    const tx = this.db.transaction(() => {
      const upd = this.db.prepare("UPDATE item_images SET position = ? WHERE id = ? AND item_id = ?");
      imageIds.forEach((id, i) => upd.run(i, id, itemId));
    });
    tx();
  }
  attachTags(itemId: number, names: string[], source: "auto" | "manual"): void {
    const tx = this.db.transaction(() => {
      const ins = this.db.prepare("INSERT OR IGNORE INTO item_tags(item_id, tag_id, source) VALUES (?,?,?)");
      for (const n of names) { if (!n?.trim()) continue; ins.run(itemId, this.ensureTag(n.trim()), source); }
    });
    tx();
    this.syncFts(itemId);
  }

  // ---------- jobs ----------
  createJob(kind: JobKind, itemId: number | null, payload: unknown, priority = 0): JobRow {
    if (itemId !== null) {
      const existing = this.db.prepare(`SELECT * FROM jobs WHERE item_id=? AND kind=? AND state IN ('queued','resolving','fetching','materializing','indexing','matching','releasing','releasing_done','paused')`).get(itemId, kind) as JobRow | undefined;
      if (existing) return existing;
    }
    const info = this.db.prepare("INSERT INTO jobs(kind, item_id, payload, state, attempts, priority, created_at) VALUES (?,?,?,'queued',0,?,?)")
      .run(kind, itemId, payload === undefined ? null : JSON.stringify(payload), priority, now());
    return this.getJob(Number(info.lastInsertRowid))!;
  }
  getJob(id: number): JobRow | null { return (this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as JobRow) ?? null; }
  listJobs(state?: string, limit = 100): JobRow[] {
    if (state) return this.db.prepare("SELECT * FROM jobs WHERE state=? ORDER BY priority DESC, id DESC LIMIT ?").all(state, limit) as JobRow[];
    return this.db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT ?").all(limit) as JobRow[];
  }
  nextQueuedJob(): JobRow | null { return (this.db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY priority DESC, id ASC LIMIT 1").get() as JobRow) ?? null; }
  /** CAS 转移：只允许冻结转移表里的边；非法事件 409；失败态复读由调用方处理。 */
  transitionJob(id: number, event: JobEvent, detail?: string): JobRow {
    const job = this.getJob(id);
    if (!job) throw Object.assign(new Error("job not found"), { code: "NOT_FOUND", status: 404 });
    const to = resolveTransition(job.state, event, { attempts: job.attempts });
    if (!to) throw Object.assign(new Error(`非法转移: ${job.state} --${event}-->`), { code: "INVALID_TRANSITION", status: 409 });
    const attempts = event === "retry" && to === "queued" ? job.attempts + 1 : job.attempts;
    const started = job.started_at ?? (to === "resolving" ? now() : null);
    const finished = (to === "done" || to === "cancelled" || to === "abandoned" || to === "failed") ? now() : null;
    const errorValue = to === "failed" ? (detail ?? job.error ?? null) : (to === "done" ? null : job.error);
    const info = this.db.prepare("UPDATE jobs SET state=?, attempts=?, started_at=?, finished_at=?, error=? WHERE id=? AND state=?")
      .run(to, attempts, started, finished, errorValue, id, job.state);
    if (info.changes !== 1) throw Object.assign(new Error("状态已被并发修改"), { code: "CONFLICT", status: 409 });
    this.db.prepare("INSERT INTO job_events(job_id, at, from_state, to_state, event, detail) VALUES (?,?,?,?,?,?)").run(id, now(), job.state, to, event, detail ?? null);
    return this.getJob(id)!;
  }
  logJobEvent(id: number, from: JobState | null, to: JobState, event: string, detail?: string): void {
    this.db.prepare("INSERT INTO job_events(job_id, at, from_state, to_state, event, detail) VALUES (?,?,?,?,?,?)").run(id, now(), from, to, event, detail ?? null);
  }
  listJobEvents(id: number) { return this.db.prepare("SELECT * FROM job_events WHERE job_id=? ORDER BY id").all(id); }
  /** 启动恢复：把在飞作业退回 queued（无锁泄漏）。 */
  recoverInFlight(): number {
    const rows = this.db.prepare(`SELECT * FROM jobs WHERE state IN ('resolving','fetching','materializing','indexing','matching','releasing','releasing_done')`).all() as JobRow[];
    const tx = this.db.transaction(() => {
      for (const j of rows) {
        this.db.prepare("UPDATE jobs SET state='queued', started_at=NULL WHERE id=?").run(j.id);
        this.logJobEvent(j.id, j.state, "queued", "recovered", "service restart");
      }
    });
    tx();
    return rows.length;
  }

  // ---------- snapshots / updates ----------
  addSnapshot(itemId: number, provider: string, data: { jsonHash?: string | null; files?: unknown; priceText?: string | null; imageUrls?: unknown }): void {
    this.db.prepare("INSERT INTO source_snapshots(item_id, captured_at, provider, json_hash, files_json, price_text, image_urls_json) VALUES (?,?,?,?,?,?,?)")
      .run(itemId, now(), provider, data.jsonHash ?? null, data.files === undefined ? null : JSON.stringify(data.files), data.priceText ?? null, data.imageUrls === undefined ? null : JSON.stringify(data.imageUrls));
  }
  latestSnapshot(itemId: number): any { return this.db.prepare("SELECT * FROM source_snapshots WHERE item_id=? ORDER BY id DESC LIMIT 1").get(itemId); }
  addUpdate(itemId: number, kind: UpdateKind, detail: unknown): void { this.db.prepare("INSERT INTO updates(item_id, detected_at, kind, detail_json, applied) VALUES (?,?,?,?,0)").run(itemId, now(), kind, JSON.stringify(detail ?? null)); }
  listUpdates(itemId: number) { return this.db.prepare("SELECT * FROM updates WHERE item_id=? ORDER BY id DESC").all(itemId); }
  markUpdatesApplied(itemId: number): void { this.db.prepare("UPDATE updates SET applied=1 WHERE item_id=?").run(itemId); }

  // ---------- collections（套装/合集）----------
  listCollections(): any[] {
    return this.db.prepare("SELECT c.*, (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id=c.id) AS itemCount FROM collections c ORDER BY c.sort, c.name").all();
  }
  ensureCollection(name: string): number {
    const ex = this.db.prepare("SELECT id FROM collections WHERE name=?").get(name) as any;
    if (ex) return ex.id;
    return Number(this.db.prepare("INSERT INTO collections(name, kind, sort, created_at) VALUES (?, 'manual', 0, ?)").run(name, now()).lastInsertRowid);
  }
  addToCollection(collectionId: number, itemIds: number[]): number {
    const tx = this.db.transaction(() => {
      let n = 0;
      const ins = this.db.prepare("INSERT OR IGNORE INTO collection_items(collection_id, item_id, position) VALUES (?,?,?)");
      for (const id of itemIds) n += ins.run(collectionId, id, 0).changes;
      return n;
    });
    return tx();
  }
  removeFromCollection(collectionId: number, itemId: number): void {
    this.db.prepare("DELETE FROM collection_items WHERE collection_id=? AND item_id=?").run(collectionId, itemId);
  }
  deleteCollection(id: number): void { this.db.prepare("DELETE FROM collections WHERE id=?").run(id); }
  collectionsOfItem(itemId: number): { id: number; name: string }[] {
    return this.db.prepare("SELECT c.id, c.name FROM collection_items ci JOIN collections c ON c.id=ci.collection_id WHERE ci.item_id=? ORDER BY c.name").all(itemId) as any[];
  }
  collectionItems(collectionId: number): number[] {
    return (this.db.prepare("SELECT item_id FROM collection_items WHERE collection_id=? ORDER BY position, item_id").all(collectionId) as any[]).map((r) => r.item_id);
  }

  // ---------- projects ----------
  listProjects() { return this.db.prepare("SELECT p.*, (SELECT COUNT(*) FROM project_imports pi WHERE pi.project_id=p.id) AS importCount FROM projects p ORDER BY p.id").all(); }
  ensureProject(name: string, path: string): number {
    const pn = normalizePath(path);
    const ex = this.db.prepare("SELECT id FROM projects WHERE path_norm=?").get(pn) as any;
    if (ex) return ex.id;
    return Number(this.db.prepare("INSERT INTO projects(name, path, path_norm, created_at) VALUES (?,?,?,?)").run(name, path, pn, now()).lastInsertRowid);
  }
  addProjectImport(projectId: number, itemId: number, assetId: number | null, note: string | null): void {
    this.db.prepare("INSERT OR REPLACE INTO project_imports(project_id, item_id, asset_id, imported_at, note) VALUES (?,?,?,?,?)").run(projectId, itemId, assetId, now(), note);
  }

  // ---------- stats / export ----------
  stats(): StatsShape {
    const one = (sql: string) => (this.db.prepare(sql).get() as any).v as number;
    return {
      items: one("SELECT COUNT(*) v FROM items WHERE status<>'trashed'"),
      assets: one("SELECT COUNT(*) v FROM assets WHERE status<>'trashed'"),
      bytes: one("SELECT COALESCE(SUM(size),0) v FROM assets WHERE status<>'trashed'"),
      avatars: one("SELECT COUNT(*) v FROM avatars"),
      inbox: one("SELECT COUNT(*) v FROM items WHERE status='inbox'"),
      missing: one("SELECT COUNT(*) v FROM assets WHERE status='missing'"),
      byCategory: this.db.prepare("SELECT COALESCE(category_name,'(未分类)') name, COUNT(*) count FROM items WHERE status<>'trashed' GROUP BY 1 ORDER BY count DESC LIMIT 40").all() as any[],
      byAvatar: this.db.prepare("SELECT a.id, a.name, COUNT(ia.item_id) count FROM avatars a JOIN item_avatars ia ON ia.avatar_id=a.id JOIN items i ON i.id=ia.item_id AND i.status<>'trashed' GROUP BY a.id ORDER BY count DESC LIMIT 60").all() as any[],
    };
  }
  exportItems(): any[] { return this.db.prepare("SELECT * FROM items ORDER BY id").all(); }

  // ---------- settings ----------
  getSetting(key: string): string | null { const r = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as any; return r?.value ?? null; }
  setSetting(key: string, value: string): void { this.db.prepare("INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
}
