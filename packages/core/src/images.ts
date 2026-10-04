/**
 * 图片探测与缩略图（core-content 所有）
 *
 * sharp 用于解码/缩放；全部走内存 Buffer（调用方决定落盘）。
 * 不可解码的字节流一律抛 AppError("INVALID_INPUT")，不抛 sharp 的裸错误。
 */
import sharp from "sharp";
import { AppError } from "./contracts";

export interface ThumbnailResult { data: Buffer; width: number; height: number; format: string }
export interface ImageProbe { width: number; height: number; format: string }

/** 默认缩略图格式：webp（体积优先，浏览器/Chromium 全支持）。 */
export const DEFAULT_THUMB_FORMAT = "webp" as const;

function isSharpLike(err: unknown): boolean {
  return typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string";
}

/**
 * probeImage：只读元数据，不解码像素。返回原始宽高与容器格式（sharp 的 metadata().format）。
 * 正例：PNG/JPEG/WebP/GIF 均可识别；反例：纯文本 → AppError INVALID_INPUT。
 */
export async function probeImage(src: Buffer): Promise<ImageProbe> {
  if (!Buffer.isBuffer(src) || src.length === 0) {
    throw new AppError("INVALID_INPUT", "probeImage: empty or non-buffer input", 400);
  }
  const meta = await readMetadata(src);
  const format = meta.format ?? null;
  if (!format || !meta.width || !meta.height) {
    throw new AppError("INVALID_INPUT", "probeImage: image has no intrinsic raster size", 400);
  }
  return { width: meta.width, height: meta.height, format };
}

/**
 * sharp 的 d.ts 用 `export = sharp` 声明，默认导入只给出**值**、不给类型命名空间，
 * 所以这里用 ReturnType 推断实例类型，而不是写 sharp.Sharp / sharp.Metadata。
 */
type SharpInstance = ReturnType<typeof sharp>;
type SharpMetadata = Awaited<ReturnType<SharpInstance["metadata"]>>;

async function readMetadata(src: Buffer): Promise<SharpMetadata> {
  try {
    return await sharp(src, { failOn: "error" }).metadata();
  } catch (err) {
    throw new AppError(
      "INVALID_INPUT",
      `probeImage: not a decodable image (${isSharpLike(err) ? (err as Error).message : String(err)})`,
      400,
    );
  }
}

function encodeThumb(pipeline: SharpInstance, format: "webp" | "jpeg"): SharpInstance {
  return format === "jpeg" ? pipeline.jpeg({ quality: 85, mozjpeg: true }) : pipeline.webp({ quality: 82, effort: 4 });
}

/**
 * makeThumbnail：等比缩放进 maxSize×maxSize 方框（fit=inside，不放大小图）。
 * - 默认格式 webp；format:"jpeg" 时输出 mozjpeg。
 * - 自动按 EXIF Orientation 旋转（rotate() 无参）。
 * - 返回值 width/height 是**输出缩略图**的实际像素尺寸（不是原图）。
 */
export async function makeThumbnail(
  src: Buffer,
  opts: { maxSize: number; format?: "webp" | "jpeg" },
): Promise<ThumbnailResult> {
  const maxSize = Math.floor(opts?.maxSize ?? 0);
  if (!Number.isFinite(maxSize) || maxSize <= 0) {
    throw new AppError("INVALID_INPUT", `makeThumbnail: maxSize must be a positive integer (got ${opts?.maxSize})`, 400);
  }
  const format: "webp" | "jpeg" = opts.format === "jpeg" ? "jpeg" : "webp";
  if (!Buffer.isBuffer(src) || src.length === 0) {
    throw new AppError("INVALID_INPUT", "makeThumbnail: empty or non-buffer input", 400);
  }
  try {
    const out = await encodeThumb(
      sharp(src, { failOn: "error" }).rotate().resize({
        width: maxSize,
        height: maxSize,
        fit: "inside",
        withoutEnlargement: true,
      }),
      format,
    ).toBuffer({ resolveWithObject: true });
    return { data: out.data, width: out.info.width, height: out.info.height, format: out.info.format };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      "INVALID_INPUT",
      `makeThumbnail: failed to decode/encode (${isSharpLike(err) ? (err as Error).message : String(err)})`,
      400,
    );
  }
}
