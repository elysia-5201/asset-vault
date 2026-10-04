/**
 * 流式文件哈希（core-content 所有）
 *
 * 设计约束：大文件（本机样本最大 627 MB .rar）必须常量内存，绝不 readFileSync。
 * 失败一律抛 AppError（可判别），不外泄裸 ENOENT/EBADF。
 */
import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { AppError } from "./contracts";

/** 读块大小：1 MiB（大文件下吞吐与内存的折中；常量内存与哈希值无关） */
const CHUNK = 1 << 20;

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

/** 把一个 Readable 全量喂进 hash（流式、常量内存）。 */
async function feed(stream: AsyncIterable<Buffer>, hash: Hash): Promise<void> {
  for await (const chunk of stream) hash.update(chunk as Buffer);
}

/** sha256File：流式计算文件的 SHA-256，返回 64 位小写 hex。 */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  try {
    await feed(createReadStream(file, { highWaterMark: CHUNK }), hash);
  } catch (err) {
    throw wrapFsError(err, file);
  }
  return hash.digest("hex");
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
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = createReadStream(file, { highWaterMark: CHUNK });
  try {
    for await (const chunk of stream) {
      const b = chunk as Buffer;
      bytes += b.length;
      hash.update(b);
    }
  } catch (err) {
    throw wrapFsError(err, file);
  }
  return { sha256: hash.digest("hex"), bytes, streamed: true };
}
