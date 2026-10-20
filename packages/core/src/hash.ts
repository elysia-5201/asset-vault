/**
 * 流式文件哈希（core-content 所有）
 *
 * 设计约束：大文件（本机样本最大 627 MB .rar）必须常量内存，绝不 readFileSync。
 * 失败一律抛 AppError（可判别），不外泄裸 ENOENT/EBADF。
 *
 * v0.6.0（lead 冻结契约）：sha256FileChunked 是唯一的流式实现，带
 *   - signal（每读一块检查一次 → CancelledError，code="CANCELLED"，status 409）
 *   - chunkSize / timeoutMs / onProgress（bytes, total|null）
 *   - 返回值 { sha256, bytes, streamed: true }
 * sha256File / sha256FileWithSize 保留原名与原有行为，内部委托给它（单一实现，不漂移）。
 */
import { createHash, type Hash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { AppError } from "./contracts";
import { deadlineOf, type AbortOptions } from "./abort";

/** 解析器语义版本（流水线缓存键用）：v0.6.1-B 缓存身份语义变更（live stat / weak 键）→ 3 */
export const HASH_VERSION = 3;

/** 读块大小：1 MiB（大文件下吞吐与内存的折中；常量内存与哈希值无关） */
const CHUNK = 1 << 20;
/** chunkSize 下限/上限：太小会让 syscall 开销失控，太大会破坏常量内存。 */
const MIN_CHUNK = 1024;
const MAX_CHUNK = 16 * 1024 * 1024;

/** 把任意 fs 错误翻译成可判别的 AppError。ENOENT/EISDIR → NOT_FOUND(404)。 */
function wrapFsError(err: unknown, file: string): AppError {
  if (err instanceof AppError) return err;
  const e = err as NodeJS.ErrnoException;
  const code = e?.code;
  if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
    return new AppError("NOT_FOUND", `file not found: ${file}`, 404);
  }
  return new AppError("INVALID_INPUT", `cannot read ${file}: ${e?.message ?? String(err)}`, 400);
}

function resolveChunk(chunkSize: number | undefined): number {
  if (chunkSize === undefined) return CHUNK;
  const n = Math.floor(chunkSize);
  if (!Number.isFinite(n) || n < MIN_CHUNK) {
    throw new AppError("INVALID_INPUT", `chunkSize must be >= ${MIN_CHUNK} bytes (got ${chunkSize})`, 400);
  }
  return Math.min(n, MAX_CHUNK);
}

/** 传入的路径本身不可读时提前失败（保持 sha256File 原有的 NOT_FOUND 语义）。 */
function assertReadable(file: string): void {
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new AppError("NOT_FOUND", `file not found: ${file}`, 404);
  } catch (err) {
    throw wrapFsError(err, file);
  }
}

/** 把一个 Readable 全量喂进 hash（流式、常量内存）。 */
async function feed(stream: AsyncIterable<Buffer>, hash: Hash): Promise<void> {
  for await (const chunk of stream) hash.update(chunk as Buffer);
}

export interface Sha256ChunkedOptions extends AbortOptions {
  /** 每块字节数，默认 1 MiB（1024..16 MiB，超出会被夹紧）。 */
  chunkSize?: number;
  /** 每读完一块回调一次；total 取 stat 的大小（取不到时为 null）。 */
  onProgress?: (bytes: number, total: number | null) => void;
}

export interface Sha256ChunkedResult { sha256: string; bytes: number; streamed: true }

/**
 * 流式计算 SHA-256，可按块检查取消、可报进度、可设总时限。
 * - 取消 → AppError code="CANCELLED"（status 409）；超时 → code="TIMEOUT"（status 408）
 * - 文件不存在 / 非普通文件 → NOT_FOUND（404），与 sha256File 一致
 * - 常量内存：峰值与文件大小无关（1 MiB 读块）
 */
export async function sha256FileChunked(file: string, opts: Sha256ChunkedOptions = {}): Promise<Sha256ChunkedResult> {
  const chunkSize = resolveChunk(opts.chunkSize);
  const deadline = deadlineOf(opts, `sha256FileChunked ${file}`);
  try {
    assertReadable(file);
    let total: number | null = null;
    try { total = statSync(file).size; } catch { total = null; }
    deadline?.check();
    const hash = createHash("sha256");
    let bytes = 0;
    const stream = createReadStream(file, { highWaterMark: chunkSize });
    try {
      for await (const chunk of stream) {
        deadline?.check();
        hash.update(chunk as Buffer);
        bytes += (chunk as Buffer).length;
        opts.onProgress?.(bytes, total);
      }
    } catch (err) {
      stream.destroy();
      throw wrapFsError(err, file);
    }
    deadline?.check();
    return { sha256: hash.digest("hex"), bytes, streamed: true };
  } finally {
    deadline?.dispose();
  }
}

/** sha256File：流式计算文件的 SHA-256，返回 64 位小写 hex（冻结接口，行为不变）。 */
export async function sha256File(file: string): Promise<string> {
  return (await sha256FileChunked(file)).sha256;
}

/** 便捷：对内存 Buffer 取 sha256（同一算法口径，便于测试对照）。 */
export function sha256Buffer(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * 流式哈希并同时统计字节数——扫描时常用（hash + size 一次 IO）。
 * streamed: 是否走流式路径（本实现恒为 true，留字段便于调用方断言）。
 */
export async function sha256FileWithSize(file: string): Promise<{ sha256: string; bytes: number; streamed: boolean }> {
  return sha256FileChunked(file);
}

/** 低层导出（测试用）：默认读块大小。 */
export const HASH_CHUNK_BYTES = CHUNK;
