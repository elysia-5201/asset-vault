import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { probeImage, makeThumbnail } from "../../../../packages/core/src/images";

export class MediaStore {
  constructor(private root: string) { mkdirSync(root, { recursive: true }); }
  dirFor(itemId: number): string { const d = join(this.root, String(itemId)); mkdirSync(d, { recursive: true }); return d; }
  /** 落盘一张图，返回 {filePath, thumbPath, sha256, width, height, bytes} */
  async saveImage(itemId: number, bytes: Buffer, extHint = "jpg"): Promise<{ filePath: string; thumbPath: string | null; sha256: string; width: number | null; height: number | null; bytes: number; ext: string }> {
    const sha = createHash("sha256").update(bytes).digest("hex");
    let probe: { width: number; height: number; format: string } | null = null;
    try { probe = await probeImage(bytes); } catch { probe = null; }
    const ext = (probe?.format ?? extHint).replace("jpeg", "jpg");
    const dir = this.dirFor(itemId);
    const filePath = join(dir, `${sha.slice(0, 16)}.${ext}`);
    if (!existsSync(filePath)) writeFileSync(filePath, bytes);
    let thumbPath: string | null = null;
    try {
      const t = await makeThumbnail(bytes, { maxSize: 512, format: "webp" });
      thumbPath = join(dir, `${sha.slice(0, 16)}.thumb.webp`);
      writeFileSync(thumbPath, t.data);
    } catch { thumbPath = null; }
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
