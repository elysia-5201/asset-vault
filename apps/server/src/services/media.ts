import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, utimesSync, lstatSync, realpathSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { probeImage, makeThumbnail } from "../../../../packages/core/src/images";

export interface SaveImageOptions { maxPixels?: number; maxSize?: number; noThumb?: boolean; }

const rootLocks = new Map<string, Promise<unknown>>();
/** 同 root 的媒体写入/清理共享互斥（所有 MediaStore 实例按 root 协调）。 */
export function withMediaRootLock<T>(root: string, fn: () => Promise<T> | T): Promise<T> {
  const key = resolve(root);
  const prev = rootLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  rootLocks.set(key, next.then(() => undefined, () => undefined));
  return next as Promise<T>;
}

/** root 自身不得为 symlink（配置 dataDir 的祖先链接允许；root 自身链接拒绝）。 */
function assertRootNotLink(root: string): void {
  let st; try { st = lstatSync(root); } catch { return; }
  if (st.isSymbolicLink()) throw new Error("media root link unsupported: " + root);
}

/** 解析配置 dataDir 的祖先链接，得到物理 media root（root 自身已确认非 link）。 */
function physicalRoot(root: string): string { return realpathSync(root); }

/** root 内数字 item 目录不得为 link（防 managed 子目录逃逸到外部）。 */
function assertManagedDir(dir: string): void {
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) throw new Error("media item dir link unsupported: " + dir);
  if (!st.isDirectory()) throw new Error("media item dir not a directory: " + dir);
}

/** 叶路径若已存在且为 symlink（含悬空）→ 拒绝；ENOENT 放行。 */
function assertLeafNotLink(p: string): void {
  try { if (lstatSync(p).isSymbolicLink()) throw new Error("media leaf link unsupported: " + p); }
  catch (e) { if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e; }
}

/** 复用前检查：symlink 或 hardlink（nlink>1）一律拒绝刷新 mtime。 */
function assertReusableFile(p: string): void {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) throw new Error("media reuse refused: symlink");
  if (st.nlink > 1) throw new Error("media reuse refused: hardlink");
}

export class MediaStore {
  constructor(private root: string) { mkdirSync(root, { recursive: true }); }
  dirFor(itemId: number): string { const d = join(this.root, String(itemId)); mkdirSync(d, { recursive: true }); return d; }

  async saveImage(itemId: number, bytes: Buffer, extHint = "jpg", opts: SaveImageOptions = {}): Promise<{ filePath: string; thumbPath: string | null; sha256: string; width: number | null; height: number | null; bytes: number; ext: string }> {
    return withMediaRootLock(this.root, async () => {
      const sha = createHash("sha256").update(bytes).digest("hex");
      let probe: { width: number; height: number; format: string } | null = null;
      try { probe = await (probeImage as unknown as (b: Buffer, o?: { maxPixels?: number }) => Promise<{ width: number; height: number; format: string }>)(bytes, { maxPixels: opts.maxPixels }); }
      catch { probe = null; }
      const ext = (probe?.format ?? extHint).replace("jpeg", "jpg");
      assertRootNotLink(this.root);
      const phys = physicalRoot(this.root);
      const dir = join(phys, String(itemId));
      mkdirSync(dir, { recursive: true });
      assertManagedDir(dir);
      const name = `${sha.slice(0, 16)}.${ext}`;
      const physFile = join(dir, name);
      const filePath = join(this.root, String(itemId), name);
      assertLeafNotLink(physFile);
      if (!existsSync(physFile)) await atomicWrite(physFile, bytes);
      else { assertReusableFile(physFile); const now = new Date(); utimesSync(physFile, now, now); }
      let thumbPath: string | null = null;
      if (!opts.noThumb) {
        try {
          const t = await (makeThumbnail as unknown as (b: Buffer, o: Record<string, unknown>) => Promise<{ data: Buffer }>)(bytes, {
            maxSize: opts.maxSize ?? 512, format: "webp", limitInputPixels: opts.maxPixels,
          });
          const tname = `${sha.slice(0, 16)}.thumb.webp`;
          const physTp = join(dir, tname);
          const tp = join(this.root, String(itemId), tname);
          assertLeafNotLink(physTp);
          if (!existsSync(physTp)) await atomicWrite(physTp, t.data);
          else { assertReusableFile(physTp); const now = new Date(); utimesSync(physTp, now, now); }
          thumbPath = tp;
        } catch { thumbPath = null; }
      }
      return { filePath, thumbPath, sha256: sha, width: probe?.width ?? null, height: probe?.height ?? null, bytes: bytes.length, ext };
    });
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
