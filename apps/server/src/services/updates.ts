import { sha256Text } from "../util";
import type { BoothItemMeta } from "../../../../packages/core/src/contracts";
import { BoothClient } from "../../../../packages/core/src/source/booth";
import type { Repo } from "../db/repo";

export interface UpdateOutcome { changed: number; kinds: string[] }

/** 与最近一次快照比较文件名/大小/价格/图片，产出 updates 行。 */
export async function checkItemUpdate(repo: Repo, client: BoothClient, itemId: number): Promise<UpdateOutcome> {
  const item = repo.getItem(itemId);
  if (!item) throw new Error(`item ${itemId} not found`);
  if (item.sourceSite !== "booth" || !item.sourceItemId) return { changed: 0, kinds: [] };
  let meta: BoothItemMeta;
  try { meta = await client.fetchItem(item.sourceItemId); }
  catch (e: any) {
    if (/404/.test(String(e?.message ?? ""))) { repo.updateItem(itemId, { source_gone: 1 }); repo.addUpdate(itemId, "file_changed", { sourceGone: true }); return { changed: 1, kinds: ["source_gone"] }; }
    throw e;
  }
  const prev = repo.latestSnapshot(itemId);
  const files = meta.variations.flatMap((v) => v.files.map((f) => ({ name: f.name, size: f.file_size ?? null, variation: v.id })));
  const jsonHash = sha256Text(JSON.stringify({ n: meta.title, p: meta.priceText, i: meta.images.map((x) => x.original), f: files }));
  const kinds: string[] = [];
  if (prev) {
    if (prev.json_hash && prev.json_hash !== jsonHash) {
      const oldFiles = prev.files_json ? JSON.parse(prev.files_json) as { name: string }[] : [];
      const oldNames = new Set(oldFiles.map((f) => f.name));
      const newOnes = files.filter((f) => !oldNames.has(f.name));
      const k = newOnes.length > 0 ? "new_file" : "file_changed";
      repo.addUpdate(itemId, k as any, { newFiles: newOnes, oldCount: oldFiles.length, newCount: files.length });
      kinds.push(k);
      if (prev.price_text !== meta.priceText) { repo.addUpdate(itemId, "price_changed", { from: prev.price_text, to: meta.priceText }); kinds.push("price_changed"); }
    }
  }
  repo.updateItem(itemId, { last_checked_at: new Date().toISOString(), source_gone: 0, price_text: meta.priceText ?? item.item.price_text, price_yen: meta.priceYen ?? item.item.price_yen });
  repo.addSnapshot(itemId, "booth", { jsonHash, files, priceText: meta.priceText, imageUrls: meta.images.map((x) => x.original) });
  return { changed: kinds.length, kinds };
}
