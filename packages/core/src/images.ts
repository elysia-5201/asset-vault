/**
 * 图片探测与缩略图（core-content 所有）
 *
 * sharp 用于解码/缩放；全部走内存 Buffer（调用方决定落盘）。
 * 不可解码的字节流一律抛 AppError("INVALID_INPUT")，不抛 sharp 的裸错误。
 *
 * v0.6.0（lead 冻结契约，向后兼容）：
 *   - probeImage(buf, opts?: { maxPixels?, signal?, timeoutMs? })：像素超限 → LimitError("PIXELS", 400)
 *   - makeThumbnail(buf, opts: { maxSize, format?: "webp"|"jpeg"|"png", limitInputPixels?, quality?, signal?, timeoutMs? })
 *     sharp 不可中断：这里用 Deadline.race —— 超时/取消立刻向上抛（code=TIMEOUT/CANCELLED），
 *     底层解码仍在后台跑完（已 catch，不会变 unhandled rejection）；需要「立刻停手」的调用方请用进程级策略。
 *
 * 解压炸弹：sharp 的 limitInputPixels 默认约 2.68 亿像素（≈1 GB RGBA）。本模块显式传入该值，
 * 让「上限从哪来」可见；调用方可以传更小的 limitInputPixels / maxPixels 提前拦截。
 */
import sharp from "sharp";
import { AppError } from "./contracts";
import { deadlineOf, type AbortOptions, type Deadline } from "./abort";
import { LimitError } from "./limits";

export interface ThumbnailResult { data: Buffer; width: number; height: number; format: string }
export interface ImageProbe { width: number; height: number; format: string }

/** 默认缩略图格式：webp（体积优先，浏览器/Chromium 全支持）。 */
export const DEFAULT_THUMB_FORMAT = "webp" as const;
/** 默认像素上限：与 sharp 内建默认一致（268,402,689 ≈ 0x3FFF×0x3FFF），显式写出来便于审计。 */
export const DEFAULT_MAX_PIXELS = 268_402_689;

export interface ImageOptions extends AbortOptions {
  /** 像素上限（宽×高）；超过 → LimitError("PIXELS") */
  maxPixels?: number;
  /** 传给 sharp 的 limitInputPixels（默认 DEFAULT_MAX_PIXELS） */
  limitInputPixels?: number;
}

function isSharpLike(err: unknown): boolean {
  return typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string";
}

/** sharp 的像素上限错误 → LimitError("PIXELS")，其它解码错误 → INVALID_INPUT。 */
function toImageError(err: unknown, what: string): AppError {
  if (err instanceof AppError) return err;
  const msg = isSharpLike(err) ? (err as Error).message : String(err);
  if (/pixel.*(limit|exceed)|exceeds.*pixel|too large/i.test(msg)) {
    return new LimitError("PIXELS", `${what}: image exceeds pixel limit (${msg.slice(0, 200)})`);
  }
  return new AppError("INVALID_INPUT", `${what}: failed to decode/encode (${msg.slice(0, 200)})`, 400);
}

function sharpConfig(opts: ImageOptions): { failOn: "error"; limitInputPixels: number } {
  const lim = opts.limitInputPixels ?? DEFAULT_MAX_PIXELS;
  return { failOn: "error", limitInputPixels: Number.isFinite(lim) && lim > 0 ? Math.floor(lim) : DEFAULT_MAX_PIXELS };
}

/**
 * probeImage：只读元数据，不解码像素。返回原始宽高与容器格式（sharp 的 metadata().format）。
 * 正例：PNG/JPEG/WebP/GIF 均可识别；反例：纯文本 → AppError INVALID_INPUT；超像素 → LimitError PIXELS。
 */
export async function probeImage(src: Buffer, opts: ImageOptions = {}): Promise<ImageProbe> {
  if (!Buffer.isBuffer(src) || src.length === 0) {
    throw new AppError("INVALID_INPUT", "probeImage: empty or non-buffer input", 400);
  }
  const deadline = deadlineOf(opts, "probeImage");
  try {
    const meta = await readMetadata(src, sharpConfig(opts), deadline);
    const format = meta.format ?? null;
    if (!format || !meta.width || !meta.height) {
      throw new AppError("INVALID_INPUT", "probeImage: image has no intrinsic raster size", 400);
    }
    if (opts.maxPixels !== undefined) {
      const max = Math.floor(opts.maxPixels);
      if (!Number.isFinite(max) || max <= 0) throw new AppError("INVALID_INPUT", `probeImage: maxPixels must be positive (got ${opts.maxPixels})`, 400);
      const pixels = meta.width * meta.height;
      if (pixels > max) {
        throw new LimitError("PIXELS", `probeImage: ${meta.width}x${meta.height} = ${pixels} pixels > maxPixels ${max}`);
      }
    }
    return { width: meta.width, height: meta.height, format };
  } finally {
    deadline?.dispose();
  }
}

/**
 * sharp 的 d.ts 用 `export = sharp` 声明，默认导入只给出**值**、不给类型命名空间，
 * 所以这里用 ReturnType 推断实例类型，而不是写 sharp.Sharp / sharp.Metadata。
 */
type SharpInstance = ReturnType<typeof sharp>;
type SharpMetadata = Awaited<ReturnType<SharpInstance["metadata"]>>;

async function readMetadata(src: Buffer, config: { failOn: "error"; limitInputPixels: number }, deadline: Deadline | null): Promise<SharpMetadata> {
  const work = (async () => sharp(src, config).metadata())();
  try {
    return deadline ? await deadline.race(work) : await work;
  } catch (err) {
    throw toImageError(err, "probeImage");
  }
}

function encodeThumb(pipeline: SharpInstance, format: "webp" | "jpeg" | "png", quality: number | undefined): SharpInstance {
  if (format === "jpeg") return pipeline.jpeg({ quality: quality ?? 85, mozjpeg: true });
  if (format === "png") return pipeline.png({ compressionLevel: 9, ...(quality ? { quality, palette: true } : {}) });
  return pipeline.webp({ quality: quality ?? 82, effort: 4 });
}

function normalizeQuality(format: "webp" | "jpeg" | "png", q: number | undefined): number | undefined {
  if (q === undefined) return undefined;
  const n = Math.floor(q);
  if (!Number.isFinite(n) || n < 1 || n > 100) {
    throw new AppError("INVALID_INPUT", `makeThumbnail: quality must be 1..100 (got ${q})`, 400);
  }
  return format === "png" ? n : n;
}

/**
 * makeThumbnail：等比缩放进 maxSize×maxSize 方框（fit=inside，不放大小图）。
 * - 默认格式 webp；format:"jpeg" 输出 mozjpeg；format:"png" 输出 PNG（quality 给定则用调色板量化）
 * - 自动按 EXIF Orientation 旋转（rotate() 无参）
 * - 返回值 width/height 是**输出缩略图**的实际像素尺寸（不是原图）
 * - limitInputPixels / quality / signal / timeoutMs 见 ImageOptions
 */
export async function makeThumbnail(
  src: Buffer,
  opts: {
    maxSize: number;
    format?: "webp" | "jpeg" | "png";
    limitInputPixels?: number;
    quality?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<ThumbnailResult> {
  const maxSize = Math.floor(opts?.maxSize ?? 0);
  if (!Number.isFinite(maxSize) || maxSize <= 0) {
    throw new AppError("INVALID_INPUT", `makeThumbnail: maxSize must be a positive integer (got ${opts?.maxSize})`, 400);
  }
  const format: "webp" | "jpeg" | "png" = opts.format === "jpeg" ? "jpeg" : opts.format === "png" ? "png" : "webp";
  const quality = normalizeQuality(format, opts.quality);
  if (!Buffer.isBuffer(src) || src.length === 0) {
    throw new AppError("INVALID_INPUT", "makeThumbnail: empty or non-buffer input", 400);
  }
  const config = sharpConfig({ limitInputPixels: opts.limitInputPixels });
  const deadline = deadlineOf(opts, `makeThumbnail maxSize=${maxSize} ${format}`);
  try {
    const work = (async () => encodeThumb(
      sharp(src, config).rotate().resize({ width: maxSize, height: maxSize, fit: "inside", withoutEnlargement: true }),
      format,
      quality,
    ).toBuffer({ resolveWithObject: true }))();
    const out = deadline ? await deadline.race(work) : await work;
    return { data: out.data, width: out.info.width, height: out.info.height, format: out.info.format };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw toImageError(err, "makeThumbnail");
  } finally {
    deadline?.dispose();
  }
}
