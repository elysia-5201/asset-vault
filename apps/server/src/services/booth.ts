import { sha256Text } from "../util";
import type { BoothItemMeta } from "../../../../packages/core/src/contracts";
import { BoothClient, parseBoothUrl } from "../../../../packages/core/src/source/booth";
import { parseDeclaredCount } from "../../../../packages/core/src/avatars/normalize";
import type { Repo } from "../db/repo";
import type { MediaStore } from "./media";

export interface ImportOutcome { itemId: number; created: boolean; images: number; meta: BoothItemMeta; files: number }

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
async function attachImagesAndSnapshot(repo: Repo, media: MediaStore, client: BoothClient, itemId: number, meta: BoothItemMeta): Promise<{ images: number; files: number }> {
  const urls = meta.images.slice(0, MAX_IMAGES);
  const already = new Set(repo.listImages(itemId).map((i) => i.source_url ?? ""));
  let images = 0;
  const startPos = repo.listImages(itemId).length;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!.original;
    if (already.has(url)) continue;
    try {
      const { bytes } = await client.fetchImage(url);
      const saved = await media.saveImage(itemId, bytes, "jpg");
      repo.addImage(itemId, {
        role: repo.listImages(itemId).some((r) => r.role === "cover") ? "gallery" : "cover",
        origin: "booth", source_url: url, file_path: saved.filePath, thumb_path: saved.thumbPath,
        width: saved.width, height: saved.height, bytes: saved.bytes, sha256: saved.sha256, position: startPos + i,
      });
      images++;
    } catch { /* 单图失败不影响建档 */ }
  }
  const files = meta.variations.flatMap((v) => v.files.map((f) => ({ name: f.name, size: f.file_size ?? null, variation: v.id })));
  repo.addSnapshot(itemId, "booth", {
    jsonHash: sha256Text(JSON.stringify({ n: meta.title, p: meta.priceText, i: meta.images.map((x) => x.original), f: files })),
    files, priceText: meta.priceText, imageUrls: meta.images.map((x) => x.original),
  });
  return { images, files: files.length };
}

const MAX_IMAGES = 12;

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
    return { itemId: targetId, created: false, images: outcome.images, meta, files: outcome.files };
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

  let images = 0;
  const urls = meta.images.slice(0, MAX_IMAGES);
  const already = new Set(repo.listImages(itemId).map((i) => i.source_url ?? ""));
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!.original;
    if (already.has(url)) continue;
    try {
      const { bytes } = await client.fetchImage(url);
      const saved = await media.saveImage(itemId, bytes, "jpg");
      repo.addImage(itemId, { role: i === 0 ? "cover" : "gallery", origin: "booth", source_url: url, file_path: saved.filePath, thumb_path: saved.thumbPath, width: saved.width, height: saved.height, bytes: saved.bytes, sha256: saved.sha256, position: i });
      images++;
    } catch { /* 单图失败不影响建档 */ }
  }
  const files = meta.variations.flatMap((v) => v.files.map((f) => ({ name: f.name, size: f.file_size ?? null, variation: v.id })));
  repo.addSnapshot(itemId, "booth", {
    jsonHash: sha256Text(JSON.stringify({ n: meta.title, p: meta.priceText, i: meta.images.map((x) => x.original), f: files })),
    files, priceText: meta.priceText, imageUrls: meta.images.map((x) => x.original),
  });
  return { itemId, created, images, meta, files: files.length };
}
