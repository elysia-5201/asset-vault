import { statSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { listArchive, readArchiveEntry } from "../../../../packages/core/src/archive/list";
import { listUnityPackage, readUnityPackagePreview } from "../../../../packages/core/src/unitypackage";
import { sha256File } from "../../../../packages/core/src/hash";
import type { Repo } from "../db/repo";
import type { MediaStore } from "./media";

const IMAGE_EXT = /(^|\.)(png|jpe?g|webp|gif|bmp|tga|psd)$/i;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES = 8;
const MAX_NESTED_PACKAGES = 2;
const MAX_NESTED_BYTES = 256 * 1024 * 1024;

export interface IndexResult { container: string; entries: number; unityAssets: number; images: number; hashed: boolean; note?: string }

/** 列目录 / 解析 unitypackage / 抽取缩略图。不启动 Unity，不搬动素材本体。 */
export async function indexAsset(repo: Repo, media: MediaStore, assetId: number, opts: { hashMaxBytes?: number } = {}): Promise<IndexResult> {
  const asset = repo.getAsset(assetId);
  if (!asset) throw new Error(`asset ${assetId} not found`);
  const res: IndexResult = { container: asset.container, entries: 0, unityAssets: 0, images: 0, hashed: false };
  const itemId = asset.item_id;

  if (asset.container === "unitypackage") {
    const listing = await listUnityPackage(asset.path, { maxAssets: 20000 });
    repo.replaceUnityPackageAssets(assetId, listing.assets);
    res.unityAssets = listing.assets.length;
    if (listing.truncated) res.note = "unitypackage listing truncated";
    const withPreview = listing.assets.filter((a) => a.hasPreview).slice(0, MAX_IMAGES);
    for (const a of withPreview) {
      try {
        const buf = await readUnityPackagePreview(asset.path, a.guid);
        if (!buf) continue;
        const saved = await media.saveImage(itemId, buf, "png");
        repo.addImage(itemId, { role: "package_preview", origin: "archive", file_path: saved.filePath, thumb_path: saved.thumbPath, width: saved.width, height: saved.height, bytes: saved.bytes, sha256: saved.sha256 });
        res.images++;
      } catch { /* 单张失败不影响整体 */ }
    }
  } else if (asset.container === "zip" || asset.container === "7z" || asset.container === "rar") {
    const listing = await listArchive(asset.path, { maxEntries: 20000 });
    repo.replaceArchiveEntries(assetId, listing.entries.map((e) => ({ path: e.path, size: e.size, isDir: e.isDir, ext: (e.path.match(/\.[^./]+$/) ?? [""])[0].toLowerCase() })));
    res.entries = listing.entries.length;
    if (listing.truncated) res.note = "archive listing truncated";
    if (listing.passwordProtected) res.note = "password protected";
    if (asset.container === "zip") {
      const imgs = listing.entries.filter((e) => !e.isDir && IMAGE_EXT.test(e.path) && e.size > 1024 && e.size < MAX_IMAGE_BYTES)
        .sort((a, b) => b.size - a.size).slice(0, MAX_IMAGES);
      for (const e of imgs) {
        try {
          const buf = await readArchiveEntry(asset.path, e.path, MAX_IMAGE_BYTES);
          if (buf.length === 0) continue;
          const saved = await media.saveImage(itemId, buf, "png");
          repo.addImage(itemId, { role: "archive_frame", origin: "archive", file_path: saved.filePath, thumb_path: saved.thumbPath, width: saved.width, height: saved.height, bytes: saved.bytes, sha256: saved.sha256 });
          res.images++;
        } catch { /* ignore single entry */ }
      }
    }
  }

  // 包里套包：zip 里通常是 .unitypackage（有的还再套一层 zip）→ 下钻一层抽包内 preview.png 当缩略图。
  // 这是"扫库建出来的条目没图"的主因（实测 Danzai_Bunny / NoemHoodie / Milky-Way 都是这种）。
  if (res.images === 0 && (asset.container === "zip" || asset.container === "7z" || asset.container === "rar")) {
    try {
      const { listArchive: listNested, readArchiveEntry: readNested } = await import("../../../../packages/core/src/archive/list");
      const outer = await listNested(asset.path, { maxEntries: 20000 });
      const candidates = outer.entries
        .filter((e) => !e.isDir && /\.(unitypackage|zip)$/i.test(e.path) && e.size > 4096 && e.size < MAX_NESTED_BYTES)
        .sort((a, b) => b.size - a.size)
        .slice(0, MAX_NESTED_PACKAGES);
      for (const cand of candidates) {
        const tmp = join(tmpdir(), "av-nested-" + process.pid + "-" + Date.now() + "-" + basename(cand.path).replace(/[^\w.\-]+/g, "_"));
        try {
          const buf = await readNested(asset.path, cand.path, MAX_NESTED_BYTES);
          if (buf.length === 0) continue;
          let inner = tmp;
          if (/\.zip$/i.test(cand.path)) {
            writeFileSync(tmp, buf);
            const innerEntries = await listNested(tmp, { maxEntries: 5000 });
            const pkg = innerEntries.entries.find((e) => !e.isDir && /\.unitypackage$/i.test(e.path) && e.size > 4096 && e.size < MAX_NESTED_BYTES);
            if (!pkg) {
              // 内层 zip 里没有 unitypackage（常见：直接放图片）→ 抽图片当缩略图
              const innerImgs = innerEntries.entries
                .filter((e) => !e.isDir && IMAGE_EXT.test(e.path) && e.size > 1024 && e.size < MAX_IMAGE_BYTES)
                .sort((a, b) => b.size - a.size).slice(0, MAX_IMAGES);
              for (const ie of innerImgs) {
                try {
                  const b2 = await readNested(tmp, ie.path, MAX_IMAGE_BYTES);
                  if (b2.length === 0) continue;
                  const saved2 = await media.saveImage(itemId, b2, "png");
                  repo.addImage(itemId, { role: "archive_frame", origin: "archive", file_path: saved2.filePath, thumb_path: saved2.thumbPath, width: saved2.width, height: saved2.height, bytes: saved2.bytes, sha256: saved2.sha256 });
                  res.images++;
                } catch { /* ignore */ }
              }
              if (res.images > 0) { res.note = (res.note ? res.note + "; " : "") + "nested-zip images:" + res.images; break; }
              continue;
            }
            inner = tmp + ".unitypackage";
            writeFileSync(inner, await readNested(tmp, pkg.path, MAX_NESTED_BYTES));
          } else {
            writeFileSync(tmp, buf);
          }
          const upkg = await listUnityPackage(inner, { maxAssets: 20000 });
          const withPreview = upkg.assets.filter((a) => a.hasPreview).slice(0, MAX_IMAGES);
          for (const a of withPreview) {
            try {
              const p = await readUnityPackagePreview(inner, a.guid);
              if (!p) continue;
              const saved = await media.saveImage(itemId, p, "png");
              repo.addImage(itemId, { role: "package_preview", origin: "archive", file_path: saved.filePath, thumb_path: saved.thumbPath, width: saved.width, height: saved.height, bytes: saved.bytes, sha256: saved.sha256 });
              res.images++;
            } catch { /* 单张失败忽略 */ }
          }
          res.note = (res.note ? res.note + "; " : "") + "nested:" + basename(cand.path) + " previews=" + withPreview.length;
          if (res.images > 0) break;
        } catch { /* 单个内层包失败不影响整条 */ }
        finally { for (const f of [tmp, tmp + ".unitypackage"]) { try { unlinkSync(f); } catch { /* ignore */ } } }
      }
    } catch { /* 下钻失败不影响索引结果 */ }
  }

  const hashMax = opts.hashMaxBytes ?? 512 * 1024 * 1024;
  try {
    const st = statSync(asset.path);
    if (st.size <= hashMax) { const sha = await sha256File(asset.path); repo.setAssetSha(assetId, sha, "ok"); res.hashed = true; }
  } catch { repo.setAssetSha(assetId, null, "error"); }

  repo.touchAsset(assetId);
  // 去重签名：只读已缓存的目录清单，失败（坏包/抽内层包超时）绝不能影响索引结果。
  // 必须放在 touchAsset 之后：computed_at < last_verified_at 会被判 stale，每次都要重算。
  try {
    const { computeSignature } = await import("./dedupe");
    await computeSignature(repo, assetId);
  } catch { /* 签名失败不影响索引 */ }
  return res;
}