/**
 * RAR 后端（core-content 所有）
 *
 * 为什么不用 7zip-bin：7za 16.02 (p7zip standalone) **不含 RAR codec**（`7za i` 格式清单无 Rar），
 * 对合法 RAR5 报 "Can not open the file as archive"；7zip-bin 最新版仍是 5.2.0。
 * 因此 RAR 走 node-unrar-js（纯 WASM，可选依赖，无系统二进制）。
 *
 * 未安装时：抛可判别的 AppError，绝不静默返回空目录（那会把"读不了"污染成"包是空的"）。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../contracts";

/** 动态 import 的模块名（变量写法：让 tsc 不要求该可选依赖存在）。 */
const UNRAR_SPEC = "node-unrar-js";

let cachedMod: any | null | undefined; // undefined=未探测, null=不可用

function unavailable(): AppError {
  return new AppError(
    "NOT_AN_ARCHIVE",
    "RAR unsupported: bundled 7za (p7zip 16.02) has no RAR codec; add optional dependency node-unrar-js@^2.0.2 and npm install",
    400,
  );
}

function translateUnrarError(err: unknown, file: string): AppError {
  if (err instanceof AppError) return err;
  const msg = (err as Error)?.message ?? String(err);
  if (/password|encrypted/i.test(msg)) {
    return new AppError("ARCHIVE_PASSWORD", `RAR entry is encrypted/password-protected: ${file}`, 400);
  }
  if (/no such file|ENOENT/i.test(msg)) return new AppError("NOT_FOUND", `rar not found: ${file}`, 404);
  return new AppError("NOT_AN_ARCHIVE", `not a readable rar (${file}): ${msg.slice(0, 400)}`, 400);
}

async function loadUnrar(): Promise<any> {
  if (cachedMod !== undefined) {
    if (cachedMod === null) throw unavailable();
    return cachedMod;
  }
  try {
    const spec: string = UNRAR_SPEC;
    cachedMod = await import(spec);
    return cachedMod;
  } catch {
    cachedMod = null;
    throw unavailable();
  }
}

/** node-unrar-js 是否可用（不抛异常，供调用方决定降级路径）。 */
export async function unrarAvailable(): Promise<boolean> {
  try { await loadUnrar(); return true; } catch { return false; }
}

/** 兼容不同版本字段名：name/unpSize/flags.directory/crc。 */
function normalizeHeader(h: any): { path: string; size: number; isDir: boolean; crc: number | null } {
  const name = String(h?.name ?? h?.fileName ?? "");
  const flags = h?.flags ?? {};
  const isDir = Boolean(flags.directory ?? flags.isDirectory ?? h?.isDirectory) || name.endsWith("/") || name.endsWith("\\");
  const rawSize = h?.unpSize ?? h?.size ?? h?.unpackedSize ?? 0;
  const size = Number(rawSize);
  const crcVal = h?.crc;
  return {
    path: name.replace(/\\/g, "/"),
    size: Number.isFinite(size) ? size : 0,
    isDir,
    crc: typeof crcVal === "number" ? crcVal >>> 0 : null,
  };
}

export interface RarListResult { entries: { path: string; size: number; isDir: boolean; crc: number | null }[]; truncated: boolean; passwordProtected: boolean; note?: string }

async function createExtractor(file: string): Promise<any> {
  const mod = await loadUnrar();
  const factory = mod.createExtractorFromFile ?? mod.default?.createExtractorFromFile;
  if (typeof factory !== "function") throw new AppError("INVALID_INPUT", "node-unrar-js: createExtractorFromFile not found", 400);
  return factory({ filepath: file });
}

/** 列出 rar 条目（最大 maxEntries，超出截断）。 */
export async function listRar(file: string, maxEntries: number): Promise<RarListResult> {
  try {
    const extractor = await createExtractor(file);
    const listed = extractor.getFileList();
    const headers = listed?.fileHeaders ?? listed;
    const entries: RarListResult["entries"] = [];
    let truncated = false;
    let passwordProtected = false;
    for (const h of headers as Iterable<any>) {
      const n = normalizeHeader(h);
      if (h?.flags?.encrypted) passwordProtected = true;
      if (entries.length >= maxEntries) { truncated = true; continue; }
      entries.push(n);
    }
    const note = passwordProtected ? "rar has encrypted entries (headers only)" : undefined;
    return { entries, truncated, passwordProtected, ...(note ? { note } : {}) };
  } catch (err) {
    const t = translateUnrarError(err, file);
    if (t.code === "ARCHIVE_PASSWORD") {
      return { entries: [], truncated: false, passwordProtected: true, note: t.message };
    }
    throw t;
  }
}

/**
 * 只取一个条目内容。
 *
 * 为什么走临时文件：node-unrar-js 的 `createExtractorFromFile` 把解出的内容**写盘**
 * （ExtractorFile.create → path.join(targetPath, filenameTransform(name))），
 * 只有 `createExtractorFromData` 才在内存返回 `extraction`——但那要求整包进内存，
 * 对 627 MB 的样本会 OOM。所以这里：解到 mkdtemp 的临时目录 → 读回 → 删目录。
 * 解包前先只用头信息校验存在性/目录/大小，避免解出超大文件。
 */
export async function readRarEntry(file: string, entryPath: string, maxBytes: number): Promise<Buffer> {
  const wanted = entryPath.replace(/\\/g, "/");
  const target = mkdtempSync(join(tmpdir(), "assetvault-rar-"));
  try {
    const mod = await loadUnrar();
    const factory = mod.createExtractorFromFile ?? mod.default?.createExtractorFromFile;
    if (typeof factory !== "function") throw new AppError("INVALID_INPUT", "node-unrar-js: createExtractorFromFile not found", 400);
    let seq = 0;
    const extractor = await factory({
      filepath: file,
      targetPath: target,
      filenameTransform: () => `entry-${seq++}.bin`, // 不信任包内路径（防 ../ 逃逸）
    });
    // 第一遍：只看头（不解压）判定存在性/类型/声明大小
    let header: any = null;
    for (const h of (extractor.getFileList()?.fileHeaders ?? []) as Iterable<any>) {
      if (normalizeHeader(h).path === wanted) { header = h; break; }
    }
    if (!header) throw new AppError("NOT_FOUND", `entry not found in rar: ${entryPath}`, 404);
    if (header?.flags?.directory) throw new AppError("INVALID_INPUT", `entry is a directory: ${entryPath}`, 400);
    const declared = Number(header?.unpSize ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new AppError("INVALID_INPUT", `entry too large: ${declared} bytes > maxBytes ${maxBytes}`, 400);
    }
    // 第二遍：驱动生成器把匹配条目写到 target
    const stream = extractor.extract({ files: (h: any) => normalizeHeader(h).path === wanted });
    for (const _f of stream.files as Iterable<any>) { void _f; }
    const written = readdirSync(target);
    if (written.length === 0) throw new AppError("NOT_FOUND", `entry not found in rar: ${entryPath}`, 404);
    const buf = readFileSync(join(target, written[0]));
    if (buf.length > maxBytes) {
      throw new AppError("INVALID_INPUT", `entry too large: ${buf.length} bytes > maxBytes ${maxBytes}`, 400);
    }
    return buf;
  } catch (err) {
    throw translateUnrarError(err, file);
  } finally {
    try { rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
