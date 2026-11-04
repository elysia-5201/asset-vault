import { sha256Text } from "../util";
import type { BoothItemMeta } from "../../../../packages/core/src/contracts";
import { BoothClient, parseBoothUrl } from "../../../../packages/core/src/source/booth";
import { parseDeclaredCount } from "../../../../packages/core/src/avatars/normalize";
import type { Repo } from "../db/repo";
import type { MediaStore } from "./media";
import { applyCategoryEvidence } from "./categories";

export interface ImageStats { requested: number; downloaded: number; added: number; reused: number; duplicates: number; failed: number }
export interface ImportOutcome { itemId: number; created: boolean; images: number; meta: BoothItemMeta; files: number; imageStats: ImageStats }

/** 从 BOOTH 元数据构造 items 字段（新建与关联共用同一套）。 */
function buildFields(parsed: { itemId: string; canonicalUrl: string }, meta: BoothItemMeta, status: "active" | "inbox") {
  return {
    source_site: "booth" as const, source_item_id: parsed.itemId, source_url: meta.url, canonical_url: parsed.canonicalUrl,
    title: meta.title, shop_name: meta.shop?.name ?? null, shop_subdomain: meta.shop?.subdomain ?? null, author: meta.shop?.name ?? null,
    price_text: meta.priceText, price_yen: meta.priceYen, published_at: meta.publishedAt, adult: meta.isAdult ? 1 : 0,
    category_name: meta.category?.name ?? null, category_parent: meta.category?.parent?.name ?? null, description: meta.description,
    compat_declared_count: parseDeclaredCount((meta.title ?? "") + "\n" + (meta.description ?? "")),
    last_checked_at: new Date().toISOString(), source_gone: 0, purchased: 1, status,
  };
}

/** 抓图集 + 写快照（幂等：已存在同 source_url 的图会跳过）。 */
async function attachImagesAndSnapshot(repo: Repo, media: MediaStore, client: BoothClient, itemId: number, meta: BoothItemMeta): Promise<{ images: number; files: number; imageStats: ImageStats }> {
  // requested = 去重后的 URL 数；重复 URL 同次只处理一次。
  const urls = [...new Set(meta.images.slice(0, MAX_IMAGES).map((u) => u.original))];
  const requested = urls.length;
  // 媒体 I/O 在事务外：对每个 URL 真实下载验证可用（含已见 URL，避免 added=0 永久不清默认）。
  const pending: { url: string; saved: Awaited<ReturnType<MediaStore["saveImage"]>> }[] = [];
  for (const url of urls) {
    try {
      const { bytes } = await client.fetchImage(url);
      const saved = await media.saveImage(itemId, bytes, "jpg");
      pending.push({ url, saved });
    } catch { /* 单图失败不影响建档 */ }
  }
  const downloaded = pending.length;
  const preexisting = new Set(repo.listImages(itemId).map((i) => i.sha256).filter(Boolean) as string[]);
  let added = 0, reused = 0, duplicates = 0;
  const ids = new Set<number>();
  if (pending.length > 0) {
    // 图片 DB 写（去重/新行/删默认/cover）原子提交；失败全部回滚。
    repo.transaction(() => {
      for (const p of pending) {
        const dup = repo.findImageBySha(itemId, p.saved.sha256);
        if (dup) {
          if (preexisting.has(p.saved.sha256)) reused++; else duplicates++;
          if (dup.origin === "user") {
            // 用户手工图：保留 origin/role；仅在 source_url 为空时补 BOOTH 地址作为来源标记。
            if (!dup.source_url) repo.updateImage(dup.id, { source_url: p.url });
          } else {
            repo.updateImage(dup.id, {
              origin: "booth", source_url: p.url, role: ids.size === 0 ? "cover" : "gallery",
              file_path: p.saved.filePath, thumb_path: p.saved.thumbPath, width: p.saved.width, height: p.saved.height, bytes: p.saved.bytes,
            });
          }
          ids.add(dup.id);
        } else {
          const img = repo.addImage(itemId, {
            role: ids.size === 0 ? "cover" : "gallery", origin: "booth", source_url: p.url,
            file_path: p.saved.filePath, thumb_path: p.saved.thumbPath, width: p.saved.width, height: p.saved.height, bytes: p.saved.bytes, sha256: p.saved.sha256,
          });
          added++;
          ids.add(img.id);
        }
      }
      for (const img of repo.listImages(itemId)) if (img.origin === "archive") repo.deleteImage(itemId, img.id);
      repo.setCover(itemId, [...ids][0]!);
    });
  }
  const files = meta.variations.flatMap((v) => v.files.map((f) => ({ name: f.name, size: f.file_size ?? null, variation: v.id })));
  repo.addSnapshot(itemId, "booth", {
    jsonHash: sha256Text(JSON.stringify({ n: meta.title, p: meta.priceText, i: meta.images.map((x) => x.original), f: files })),
    files, priceText: meta.priceText, imageUrls: meta.images.map((x) => x.original),
  });
  const imageStats: ImageStats = { requested, downloaded, added, reused, duplicates, failed: requested - downloaded };
  return { images: ids.size, files: files.length, imageStats };
}

const MAX_IMAGES = 12;

/**
 * 分类钩子（§5-2）：BOOTH 元数据（标题/描述/BOOTH 分类/店铺/标签）落地后重跑一次分类。
 * 走 applyCategoryEvidence（内部只经 repo.applyAutoCategory）；分类异常绝不阻断导入。
 */
function classifyQuietly(repo: Repo, itemId: number): void {
  try { applyCategoryEvidence(repo, itemId); }
  catch { /* 分类异常不得阻断导入 */ }
}

/** 抓 BOOTH 商品元数据 + 图集，落地条目（幂等：同 (booth, itemId) 更新而非重复建）。 */
export async function importBoothUrl(
  repo: Repo,
  media: MediaStore,
  client: BoothClient,
  url: string,
  opts: { targetItemId?: number; onConflict?: "error" | "merge" } = {},
): Promise<ImportOutcome> {
  const parsed = parseBoothUrl(url);
  if (!parsed) throw Object.assign(new Error("不是有效的 BOOTH 商品链接"), { code: "INVALID_INPUT", status: 400 });
  const meta = await client.fetchItem(parsed.itemId);
  const owner = repo.getItemBySource("booth", parsed.itemId);
  // 关联到"已有的本地条目"：把元数据/图集灌给这条，而不是新建
  if (opts.targetItemId !== undefined) {
    let targetId = opts.targetItemId;
    if (owner && owner.id !== targetId) {
      if (opts.onConflict === "merge") {
        const moved = repo.moveAssets(targetId, owner.id);
        repo.updateItem(targetId, { status: "trashed" });
        repo.syncFts(owner.id);
        targetId = owner.id;
        void moved;
      } else {
        throw Object.assign(
          new Error("该商品已属于条目 #" + owner.id + "「" + owner.title + "」，可选择合并"),
          { code: "CONFLICT", status: 409, conflictItemId: owner.id },
        );
      }
    }
    const fields2 = buildFields(parsed, meta, "active");
    repo.updateItem(targetId, fields2 as any);
    repo.attachTags(targetId, meta.tags.map((t) => t.name), "auto");
    const outcome = await attachImagesAndSnapshot(repo, media, client, targetId, meta);
    classifyQuietly(repo, targetId);
    return { itemId: targetId, created: false, images: outcome.images, meta, files: outcome.files, imageStats: outcome.imageStats };
  }
  const existing = owner;
  const fields = {
    source_site: "booth" as const, source_item_id: parsed.itemId, source_url: meta.url, canonical_url: parsed.canonicalUrl,
    title: meta.title, shop_name: meta.shop?.name ?? null, shop_subdomain: meta.shop?.subdomain ?? null, author: meta.shop?.name ?? null,
    price_text: meta.priceText, price_yen: meta.priceYen, published_at: meta.publishedAt, adult: meta.isAdult ? 1 : 0,
    category_name: meta.category?.name ?? null, category_parent: meta.category?.parent?.name ?? null, description: meta.description,
    compat_declared_count: parseDeclaredCount(`${meta.title}\n${meta.description ?? ""}`),
    last_checked_at: new Date().toISOString(), source_gone: 0, purchased: 1,
  };
  void buildFields;
  let itemId: number; let created = false;
  if (existing) { repo.updateItem(existing.id, fields as any); itemId = existing.id; }
  else { const row = repo.createItem({ ...(fields as any), status: "active" }); itemId = row.id; created = true; }
  repo.attachTags(itemId, meta.tags.map((t) => t.name), "auto");

  const outcome = await attachImagesAndSnapshot(repo, media, client, itemId, meta);
  classifyQuietly(repo, itemId);
  return { itemId, created, images: outcome.images, meta, files: outcome.files, imageStats: outcome.imageStats };
}

/**
 * 提交后 attach-only（spec §6.4 / P3-6）：只给**已存在**的 item 附加 BOOTH 元数据/图片/标签/分类。
 * 契约：禁止 createItem、禁止 moveAssets、禁止改 asset owner；失败由调用方 best-effort 处理。
 * 不复用 importBoothUrl（它会建 item / 迁资产）。
 */
export async function attachBoothMetadata(
  repo: Repo,
  media: MediaStore,
  client: BoothClient,
  itemId: number,
  meta: BoothItemMeta,
): Promise<void> {
  if (!repo.getItem(itemId)) {
    throw Object.assign(new Error("attachBoothMetadata: item 不存在 #" + itemId), { code: "NOT_FOUND", status: 404 });
  }
  const parsed = parseBoothUrl(meta.url) ?? { itemId: meta.itemId, canonicalUrl: meta.url };
  // attach-only：status 是生命周期字段，不在允许列表；保留既有 status（inbox/active/archived/trashed），
  // 不能从 inbox 推断“本事务新建”再擅置 active（会复活 trashed/archived item）。
  const fields = buildFields(parsed, meta, "active") as Record<string, unknown>;
  delete fields.status;
  repo.updateItem(itemId, fields as any);
  repo.attachTags(itemId, meta.tags.map((t) => t.name), "auto");
  await attachImagesAndSnapshot(repo, media, client, itemId, meta);
  classifyQuietly(repo, itemId);
}
