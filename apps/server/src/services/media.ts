import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { probeImage, makeThumbnail } from "../../../../packages/core/src/images";

export interface SaveImageOptions {
  /** 解码像素上限（防 decompression bomb）；默认 40MP */
  maxPixels?: number;
  /** 缩略图长边；默认 512 */
  maxSize?: number;
  /** 跳过缩略图生成（只存原图） */
  noThumb?: boolean;
}

export class MediaStore {
  constructor(private root: string) { mkdirSync(root, { recursive: true }); }
  dirFor(itemId: number): string { const d = join(this.root, String(itemId)); mkdirSync(d, { recursive: true }); return d; }

  /** 落盘一张图，返回 {filePath, thumbPath, sha256, width, height, bytes}。写入一律 tmp + rename（崩溃不留半张图）。 */
  async saveImage(itemId: number, bytes: Buffer, extHint = "jpg", opts: SaveImageOptions = {}): Promise<{ filePath: string; thumbPath: string | null; sha256: string; width: number | null; height: number | null; bytes: number; ext: string }> {
    const sha = createHash("sha256").update(bytes).digest("hex");
    let probe: { width: number; height: number; format: string } | null = null;
    try { probe = await (probeImage as unknown as (b: Buffer, o?: { maxPixels?: number }) => Promise<{ width: number; height: number; format: string }>)(bytes, { maxPixels: opts.maxPixels }); }
    catch { probe = null; }
    const ext = (probe?.format ?? extHint).replace("jpeg", "jpg");
    const dir = this.dirFor(itemId);
    const filePath = join(dir, `${sha.slice(0, 16)}.${ext}`);
    if (!existsSync(filePath)) await atomicWrite(filePath, bytes);
    let thumbPath: string | null = null;
    if (!opts.noThumb) {
      try {
        const t = await (makeThumbnail as unknown as (b: Buffer, o: Record<string, unknown>) => Promise<{ data: Buffer }>)(bytes, {
          maxSize: opts.maxSize ?? 512, format: "webp", limitInputPixels: opts.maxPixels,
        });
        thumbPath = join(dir, `${sha.slice(0, 16)}.thumb.webp`);
        if (!existsSync(thumbPath)) await atomicWrite(thumbPath, t.data);
      } catch { thumbPath = null; }
    }
    return { filePath, thumbPath, sha256: sha, width: probe?.width ?? null, height: probe?.height ?? null, bytes: bytes.length, ext };
  }
  readThumbOrOriginal(image: { thumb_path: string | null; file_path: string | null }, width?: number): { data: Buffer; contentType: string } | null {
    const p = image.thumb_path && existsSync(image.thumb_path) ? image.thumb_path : image.file_path && existsSync(image.file_path) ? image.file_path : null;
    if (!p) return null;
    const data = readFileSync(p);
    const contentType = p.endsWith(".webp") ? "image/webp" : p.endsWith(".png") ? "image/png" : p.endsWith(".gif") ? "image/gif" : "image/jpeg";
    void width;
    return { data, contentType };
  }
  resolvePath(image: { thumb_path: string | null; file_path: string | null }): string | null {
    if (image.thumb_path && existsSync(image.thumb_path)) return image.thumb_path;
    if (image.file_path && existsSync(image.file_path)) return image.file_path;
    return null;
  }
}

/**
 * 原子写：同目录临时文件 → rename。失败时清掉临时文件，绝不留下可被当成有效缓存的半成品。
 * 用异步 fs：1000 张图逐个 writeFileSync 会在某次磁盘 journal 提交时阻塞事件循环（实测 ~1s 停顿）。
 */
async function atomicWrite(file: string, data: Buffer): Promise<void> {
  const tmp = file + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2, 8);
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch { /* ignore */ }
    throw e;
  }
}
