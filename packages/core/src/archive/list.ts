/**
 * 压缩包目录解析 / 单条目读取（core-content 所有）
 *
 * 容器分工（见 docs/CONTRACT.md；§5 关于 rar 的说法已由本模块实测更正）：
 *   - zip          → node-stream-zip（纯 JS 中央目录解析）
 *   - 7z           → 7zip-bin 自带 7za 二进制 spawn（本机无系统 7z/rar，禁止依赖）
 *   - rar          → ../archive/rar.ts（node-unrar-js）：
 *                    **7za 16.02 不含 RAR codec**，对合法 RAR5 报 "Can not open the file as archive"，
 *                    且 7zip-bin 最新版仍是 5.2.0 → 必须换后端，已实测 19/19 个 rar 样本
 *   - unitypackage → 不属于本模块，交给 ../unitypackage.ts（这里遇到会抛 NOT_AN_ARCHIVE）
 *
 * 错误策略（"可判别结果而不是裸异常"）：
 *   - 加密包   → listArchive 返回 { passwordProtected: true, note }；readArchiveEntry 抛 AppError("ARCHIVE_PASSWORD")
 *   - 损坏/非包 → 抛 AppError("NOT_AN_ARCHIVE")，message 带工具原始输出的尾巴（便于诊断）
 *   - 文件不存在 → AppError("NOT_FOUND", 404)
 * 绝不把 ENOENT / 7za 的原始 Error 直接抛给调用方。
 *
 * v0.6.0（lead 冻结契约，向后兼容）：
 *   - listArchive 新增 opts: maxEntries / maxEntryBytes / maxTotalBytes / maxCompressionRatio / timeoutMs / signal
 *     超限 **不抛**，返回 limited:{code,message} + bytesListed（流水线据此降级、调大限制后重跑）
 *   - readArchiveEntry 新增第 4 参 opts: timeoutMs / signal；条目过大抛 LimitError(code="BYTES")
 *   - ARCHIVE_PARSER_VERSION=2：语义/限制变化就 +1（流水线缓存键带版本）
 *   - 取消检查点：zip 每条中央目录记录 / 每条条目、7z 每轮 spawn 输出、rar 每条头部；
 *     7za 子进程在取消或超时时立即 SIGKILL（不等它自己退出）
 *
 * 审计结论（v0.6.0 phase-1，2026-10-20 实测，详见 logs/audit-*.log）：
 *   - 列目录本身不读包体：2.9GB 7z 列 12 条 28ms/+0.3MB，648MB zip 列 901 条 19ms/+0.5MB
 *   - 单条目读取才是内存峰值来源：node-stream-zip 87MB 条目峰值 +145.8MB（1.67×）、事件循环停顿 110ms；
 *     7za -so 14.6MB 条目峰值 +58.5MB（3.8×，Buffer.concat + 全量 utf8 解码各一份）
 *   - rar 走临时文件（+6.9MB / 74.7MB 条目）是当前最省内存的读法
 *   - sha256 流式恒定内存（648MB / 3.7s / 峰值 +0MB）
 */
import { spawn } from "node:child_process";
import { accessSync, chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, mkdtempSync, openSync, readSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { AppError, type ArchiveEntry, type ArchiveListing, type ContainerKind } from "../contracts";
import { CancelledError, TimeoutError, deadlineOf, isCancelledError, isTimeoutError, type AbortOptions, type Deadline } from "../abort";
import { LimitError, normalizeLimit, type ListingLimit } from "../limits";
import { listRar, readRarEntry } from "./rar";
import { listFromScan, nameScore, readZipEntryFromCentralDirectory, scanZipCentralDirectory } from "./zip-cd";

const require_ = createRequire(import.meta.url);

/** 解析器语义版本：限制/输出语义变化时 +1（流水线缓存键用它，避免旧缓存混入新语义）。 */
export const ARCHIVE_PARSER_VERSION = 2;

/** 单条目读取的默认字节上限（64 MiB）：超过即抛 LimitError(code="BYTES")，绝不 OOM。 */
export const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** listArchive 默认列出的最大条目数（防止超大包把内存/DB 打满）。 */
export const DEFAULT_MAX_ENTRIES = 20000;
/** 默认总字节上限：null = 不设（保持旧行为；流水线会显式传）。 */
export const DEFAULT_MAX_TOTAL_BYTES: number | null = null;
/** 默认压缩比上限：null = 不设（建议 200：正常素材包通常 < 20，炸弹常在 1000+）。 */
export const DEFAULT_MAX_COMPRESSION_RATIO: number | null = null;
/** 7za 单次调用的默认超时（毫秒）：损坏包可能让工具挂住；传了 opts.timeoutMs 时以调用方为准。 */
const SEVEN_ZIP_TIMEOUT_MS = 120_000;

export { safeEntryPath } from "./safepath";
export type { SafePathResult, SafePathOk, SafePathRejected } from "./safepath";

// ---------------------------------------------------------------- 上限状态机

interface ListingState {
  entries: ArchiveEntry[];
  truncated: boolean;
  limited: ListingLimit | null;
  bytesListed: number;
  maxEntries: number;
  maxEntryBytes: number | null;
  maxTotalBytes: number | null;
  maxRatio: number | null;
  notes: string[];
  passwordProtected: boolean;
}

function makeState(opts: { maxEntries?: number; maxEntryBytes?: number | null; maxTotalBytes?: number | null; maxCompressionRatio?: number | null }): ListingState {
  const maxEntries = Math.max(1, Math.floor(opts.maxEntries ?? DEFAULT_MAX_ENTRIES));
  return {
    entries: [], truncated: false, limited: null, bytesListed: 0,
    maxEntries,
    maxEntryBytes: normalizeLimit("maxEntryBytes", opts.maxEntryBytes, 1),
    maxTotalBytes: normalizeLimit("maxTotalBytes", opts.maxTotalBytes, 1),
    maxRatio: normalizeLimit("maxCompressionRatio", opts.maxCompressionRatio, 1),
    notes: [], passwordProtected: false,
  };
}

/**
 * 把一条条目并入结果；返回 false 表示"该停了"（调用方 break）。
 * 语义：条目数满 / 累计字节超 → 停（truncated=true）；单条过大 / 压缩比异常 → 只标记不停。
 */
function addEntry(st: ListingState, e: { path: string; size: number; isDir: boolean; crc?: number | null }, packedSize?: number | null): boolean {
  if (st.entries.length >= st.maxEntries) {
    st.truncated = true;
    if (!st.limited) st.limited = { code: "ENTRIES", message: `stopped at maxEntries=${st.maxEntries}` };
    return false;
  }
  if (st.maxTotalBytes !== null && st.bytesListed + e.size > st.maxTotalBytes) {
    st.truncated = true;
    if (!st.limited) st.limited = { code: "BYTES", message: `bytesListed ${st.bytesListed} + entry ${e.size} > maxTotalBytes ${st.maxTotalBytes}` };
    return false;
  }
  if (st.maxEntryBytes !== null && e.size > st.maxEntryBytes && !st.limited) {
    st.limited = { code: "BYTES", message: `entry ${e.path.slice(0, 80)} declared ${e.size} > maxEntryBytes ${st.maxEntryBytes}` };
  }
  if (st.maxRatio !== null && typeof packedSize === "number" && packedSize > 0 && e.size / packedSize > st.maxRatio && !st.limited) {
    st.limited = { code: "RATIO", message: `entry ${e.path.slice(0, 80)} ratio ${(e.size / packedSize).toFixed(1)}:1 > maxCompressionRatio ${st.maxRatio}` };
  }
  st.entries.push({ path: e.path, size: e.size, isDir: e.isDir, ...(e.crc === undefined ? {} : { crc: e.crc }) });
  st.bytesListed += e.size;
  return true;
}

function limitFromStop(err: unknown): ListingLimit | null {
  if (isCancelledError(err)) return { code: "CANCELLED", message: (err as Error).message };
  if (isTimeoutError(err)) return { code: "TIMEOUT", message: (err as Error).message };
  return null;
}

// ---------------------------------------------------------------- 容器探测

/** 按魔数探测容器；魔数不认识时退回扩展名；都不认识返回 null。 */
export function detectContainer(file: string): ContainerKind | null {
  let magic: Buffer;
  try {
    const fd = openSync(file, "r");
    try {
      magic = Buffer.alloc(8);
      const n = readSync(fd, magic, 0, 8, 0);
      magic = magic.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  if (magic.length >= 4 && magic[0] === 0x50 && magic[1] === 0x4b) {
    // 50 4B 03 04 (local header) / 05 06 (empty) / 07 08 (spanned)
    if (magic[2] === 0x03 || magic[2] === 0x05 || magic[2] === 0x07) return "zip";
  }
  if (magic.length >= 6 && magic.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return "7z";
  if (magic.length >= 7 && magic.subarray(0, 7).equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]))) return "rar";
  if (magic.length >= 8 && magic.subarray(0, 8).equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]))) return "rar";
  if (magic.length >= 2 && magic[0] === 0x1f && magic[1] === 0x8b) {
    return file.toLowerCase().endsWith(".unitypackage") ? "unitypackage" : null;
  }
  const lower = file.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".7z")) return "7z";
  if (lower.endsWith(".rar")) return "rar";
  if (lower.endsWith(".unitypackage")) return "unitypackage";
  return null;
}

function assertReadableFile(file: string): void {
  let st;
  try {
    st = statSync(file);
  } catch {
    throw new AppError("NOT_FOUND", `archive not found: ${file}`, 404);
  }
  if (!st.isFile()) throw new AppError("NOT_AN_ARCHIVE", `not a regular file: ${file}`, 400);
}

// ---------------------------------------------------------------- zip (node-stream-zip)

type ZipEntryLike = {
  name: string;
  size?: number;
  compressedSize?: number;
  isDirectory?: boolean;
  isFile?: boolean;
  crc?: number;
  encrypted?: boolean;
};

function loadStreamZip(): any {
  try {
    return require_("node-stream-zip");
  } catch (err) {
    throw new AppError(
      "INVALID_INPUT",
      `node-stream-zip not installed (${(err as Error).message}); run npm install in repo root`,
      400,
    );
  }
}

/**
 * 判定 zip 是否加密：优先看中央目录的通用位标志（bit0）。
 * node-stream-zip 的 ZipEntry 在某些版本不带 encrypted 字段，故自行扫描中央目录兜底。
 */
function zipCentralDirectoryEncrypted(file: string): boolean | null {
  try {
    const { openSync: o, readSync: r, fstatSync, closeSync: c } = require_("node:fs") as typeof import("node:fs");
    const fd = o(file, "r");
    try {
      const size = fstatSync(fd).size;
      const tailLen = Math.min(size, 66_000);
      const tail = Buffer.alloc(tailLen);
      r(fd, tail, 0, tailLen, size - tailLen);
      // 找 EOCD 签名 50 4B 05 06（从尾部往前找第一个）
      let eocd = -1;
      for (let i = tail.length - 22; i >= 0; i--) {
        if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
      }
      if (eocd < 0) return null;
      const cdOffset = tail.readUInt32LE(eocd + 16);
      // 可能 >4GiB（zip64）——本项目样本不涉及；探测失败就交给上层
      if (cdOffset >= size) return null;
      const head = Buffer.alloc(46);
      r(fd, head, 0, 46, cdOffset);
      if (!(head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x01 && head[3] === 0x02)) return null;
      const flags = head.readUInt16LE(8);
      return (flags & 0x0001) !== 0;
    } finally {
      c(fd);
    }
  } catch {
    return null;
  }
}

/**
 * 文件名编码探测：zip 的 UTF-8 标志位缺失时（Windows Explorer 打的日文/中文包很常见），
 * node-stream-zip 默认按 UTF-8 解码 → 出现 U+FFFD。这里按候选编码重开并选替换字符最少的那个。
 * 结果按文件路径缓存（同一 zip 的多次 entry 查找不重复探测）。
 *
 * 已知风险（审计结论）：这张 Map 无上限、也从不失效——文件被替换后仍会用旧编码。
 * 长期运行的进程建议按扫描批次清理（见 audit 报告的"建议改动清单"）。
 */
type ZipEncoding = "utf8" | "shift_jis" | "gbk" | "cp437";
const zipEncodingCache = new Map<string, ZipEncoding>();
const NAME_ENCODING_CANDIDATES: readonly ZipEncoding[] = ["shift_jis", "gbk", "cp437"];

// nameScore / 编码打分口径见 ./zip-cd.ts（单一实现，两条 zip 路径共用，避免双实现漂移）

interface DecodedZip { zip: any; entries: Record<string, ZipEntryLike>; encoding: ZipEncoding; note?: string }

async function openZipDecoded(file: string, deadline: Deadline | null): Promise<DecodedZip> {
  const StreamZip = loadStreamZip();
  deadline?.check();
  const cached = zipEncodingCache.get(file);
  if (cached) {
    const zip = new StreamZip.async({ file, ...(cached === "utf8" ? {} : { nameEncoding: cached }) });
    const entries = (await zip.entries()) as Record<string, ZipEntryLike>;
    deadline?.check();
    return { zip, entries, encoding: cached };
  }
  let zip = new StreamZip.async({ file });
  let entries = (await zip.entries()) as Record<string, ZipEntryLike>;
  deadline?.check();
  const baseBad = nameScore(Object.keys(entries));
  if (baseBad === 0) {
    zipEncodingCache.set(file, "utf8");
    return { zip, entries, encoding: "utf8" };
  }
  let best: { enc: ZipEncoding; zip: any; entries: Record<string, ZipEntryLike>; bad: number } | null = null;
  for (const enc of NAME_ENCODING_CANDIDATES) {
    deadline?.check();
    let z: any;
    try {
      z = new StreamZip.async({ file, nameEncoding: enc });
      const es = (await z.entries()) as Record<string, ZipEntryLike>;
      const bad = nameScore(Object.keys(es));
      if (!best || bad < best.bad) {
        if (best) { try { await best.zip.close(); } catch { /* */ } }
        best = { enc, zip: z, entries: es, bad };
      } else {
        try { await z.close(); } catch { /* */ }
      }
    } catch {
      try { if (z) await z.close(); } catch { /* */ }
    }
  }
  if (best && best.bad < baseBad) {
    try { await zip.close(); } catch { /* */ }
    zipEncodingCache.set(file, best.enc);
    return { zip: best.zip, entries: best.entries, encoding: best.enc, note: `legacy zip filename encoding decoded as ${best.enc}` };
  }
  zipEncodingCache.set(file, "utf8");
  return { zip, entries, encoding: "utf8" };
}

/**
 * 把 node-stream-zip 的异常翻译成可判别 AppError。
 * node-stream-zip 对加密条目的原文是 `Error('Entry encrypted')`（node_stream_zip.js:475），
 * 损坏包则是 zlib/中央目录解析错误 → 统一归到 NOT_AN_ARCHIVE 并附原文尾巴。
 */
function translateArchiveError(err: unknown, file: string, container: string, entryPath?: string): AppError {
  if (err instanceof AppError) return err;
  const e = err as NodeJS.ErrnoException;
  const msg = e?.message ?? String(err);
  if (/encrypted|password/i.test(msg)) {
    return new AppError("ARCHIVE_PASSWORD", `${container} entry is encrypted (no password support): ${entryPath ?? file}`, 400);
  }
  if (e?.code === "ENOENT") return new AppError("NOT_FOUND", `archive not found: ${file}`, 404);
  if (e?.code === "EISDIR") return new AppError("NOT_AN_ARCHIVE", `not a file: ${file}`, 400);
  return new AppError("NOT_AN_ARCHIVE", `cannot read ${container} (${file}): ${msg.slice(0, 400)}`, 400);
}

function isMaliciousEntryError(err: unknown): boolean {
  return /malicious entry/i.test((err as Error)?.message ?? "");
}

/** zip 列表（含加密标志）；node-stream-zip 因 "Malicious entry" 拒绝整包时回退到自研 CD 解析。 */
async function listZipWithPassword(file: string, st: ListingState, deadline: Deadline | null): Promise<void> {
  let zip: any;
  try {
    const opened = await openZipDecoded(file, deadline);
    zip = opened.zip;
    const raw = opened.entries;
    if (opened.note) st.notes.push(opened.note);
    for (const e of Object.values(raw)) {
      deadline?.check();
      if (e.encrypted) st.passwordProtected = true;
      const normalized = e.name.replace(/\\/g, "/");
      const isDir = e.isDirectory === true || (e.isFile === false && normalized.endsWith("/"));
      const path = normalized.replace(/\/+$/, "");
      const crc = typeof e.crc === "number" ? e.crc >>> 0 : null;
      if (!addEntry(st, { path, size: Number(e.size ?? 0), isDir, crc }, Number(e.compressedSize ?? 0) || null)) break;
    }
    if (st.passwordProtected) st.notes.push("zip has encrypted entries (per-entry flag set)");
  } catch (err) {
    // node-stream-zip 的 validateName() 见到任何含 "\\" 的条目名就抛 "Malicious entry"，
    // 整包列目录失败。现实里 Windows 工具生成的 zip 普遍如此（本机样本 901/901 条）。
    // 回退到自研中央目录解析：反斜杠归一化为 "/"，只跳过真正危险的（绝对路径/盘符/..）。
    const limit = limitFromStop(err);
    if (limit) { st.limited = limit; st.truncated = true; return; }
    if (isMaliciousEntryError(err)) { await listZipViaCentralDirectory(file, st, deadline); return; }
    throw translateArchiveError(err, file, "zip");
  } finally {
    try { if (zip) await zip.close(); } catch { /* ignore */ }
  }
}

/** 中央目录回退路径：可列出、note 里说明归一化了多少条、跳过了多少条危险项。 */
async function listZipViaCentralDirectory(file: string, st: ListingState, deadline: Deadline | null): Promise<void> {
  let scan;
  try {
    scan = scanZipCentralDirectory(file, {
      deadline,
      limits: { maxEntries: st.maxEntries, maxTotalBytes: st.maxTotalBytes, maxEntryBytes: st.maxEntryBytes, maxCompressionRatio: st.maxRatio },
    });
  } catch (err) {
    const limit = limitFromStop(err);
    if (limit) { st.limited = limit; st.truncated = true; return; }
    throw err;
  }
  const { entries } = listFromScan(scan, st.maxEntries);
  for (const e of entries) addEntry(st, e);
  if (scan.truncated) st.truncated = true;
  if (scan.limited && !st.limited) st.limited = scan.limited;
  if (scan.passwordProtected) st.passwordProtected = true;
  if (scan.unsafeSkipped > 0) {
    const head = scan.unsafeReasons.slice(0, 3).join(" | ");
    const suffix = head ? ` (e.g. ${head})` : "";
    st.notes.push(`skipped ${scan.unsafeSkipped} unsafe entries${suffix}`);
  }
  if (scan.backslashNormalized > 0) st.notes.push(`normalized ${scan.backslashNormalized} backslash paths to "/"`);
  if (scan.encoding !== "utf8") st.notes.push(`legacy zip filename encoding decoded as ${scan.encoding}`);
  if (scan.zip64) st.notes.push("zip64 archive");
  if (st.notes.length === 0) st.notes.push("listed via central directory fallback");
}

async function readZipEntry(file: string, entryPath: string, maxBytes: number, deadline: Deadline | null): Promise<Buffer> {
  let zip: any;
  try {
    deadline?.check();
    const opened = await openZipDecoded(file, deadline);
    zip = opened.zip;
    const e = (await zip.entry(entryPath)) as ZipEntryLike | undefined;
    if (!e) throw new AppError("NOT_FOUND", `entry not found in zip: ${entryPath}`, 404);
    if (e.isDirectory) throw new AppError("INVALID_INPUT", `entry is a directory: ${entryPath}`, 400);
    const declared = Number(e.size ?? 0);
    if (declared > maxBytes) {
      throw new LimitError("BYTES", `entry too large: ${declared} bytes > maxBytes ${maxBytes}`);
    }
    deadline?.check();
    const data = (await zip.entryData(entryPath)) as Buffer;
    // 声明大小可能撒谎：解压后必须再校验一次（避免跑到 maxBytes 之外）
    if (data.length > maxBytes) {
      throw new LimitError("BYTES", `entry too large: ${data.length} bytes > maxBytes ${maxBytes}`);
    }
    deadline?.check();
    return data;
  } catch (err) {
    const limit = limitFromStop(err);
    if (limit) throw limit.code === "CANCELLED" ? new CancelledError(limit.message) : new TimeoutError(limit.message);
    // 与 listArchive 同一原因：这类包 node-stream-zip 建不出条目表 → 走自研 CD 直读
    if (isMaliciousEntryError(err)) return readZipEntryFromCentralDirectory(file, entryPath, maxBytes, { deadline });
    if (err instanceof AppError) throw err;
    throw translateArchiveError(err, file, "zip", entryPath);
  } finally {
    try { if (zip) await zip.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- 7z (7zip-bin)

let cached7za: string | null = null;
/** 当前 7za 的解析信息（排障/测试用）。tempCopy=true 表示 node_modules 里的原件没有可执行位。 */
let sevenZipInfo: { path: string; tempCopy: boolean; source: string } | null = null;

/** 返回本次解析到的 7za 路径及是否用了 tmp 自愈副本。 */
export function sevenZipBinaryInfo(): { path: string; tempCopy: boolean; source: string } | null {
  return sevenZipInfo;
}

/**
 * 7zip-bin 的 7za 在 npm 解包后经常丢可执行位（本机实测 Permission denied）。
 * 不自愈就得依赖外部 chmod，故这里把二进制复制到 tmp 并 chmod 755 后使用（进程内缓存）。
 */
function ensureExecutable(bin: string): string {
  try {
    accessSync(bin, fsConstants.X_OK);
    return bin;
  } catch { /* 没有 x 位，走复制自愈 */ }
  try {
    const dir = mkdtempSync(join(tmpdir(), "assetvault-7za-"));
    const dst = join(dir, process.platform === "win32" ? "7za.exe" : "7za");
    copyFileSync(bin, dst);
    chmodSync(dst, 0o755);
    // 排障标记（lead 要求）：明确告诉使用者跑的是临时副本，不是 node_modules 里的原件
    console.warn(`[assetvault] 7za: using temp copy (no exec bit) src=${bin} dst=${dst}`);
    sevenZipInfo = { path: dst, tempCopy: true, source: bin };
    return dst;
  } catch (err) {
    throw new AppError("INVALID_INPUT", `7za not executable and self-heal copy failed (${(err as Error).message}): ${bin}`, 400);
  }
}

function resolve7za(): string {
  if (cached7za) return cached7za;
  let mod: any;
  try {
    mod = require_("7zip-bin");
  } catch (err) {
    throw new AppError("INVALID_INPUT", `7zip-bin not installed (${(err as Error).message}); run npm install in repo root`, 400);
  }
  const bin = mod?.path7za ?? mod?.default?.path7za;
  if (typeof bin !== "string" || !bin) throw new AppError("INVALID_INPUT", "7zip-bin did not expose path7za", 400);
  if (!existsSync(bin)) throw new AppError("INVALID_INPUT", `7zip-bin binary missing on disk: ${bin}`, 400);
  if (!sevenZipInfo) sevenZipInfo = { path: bin, tempCopy: false, source: bin };
  cached7za = ensureExecutable(bin);
  sevenZipInfo = { ...(sevenZipInfo ?? { source: bin }), path: cached7za };
  return cached7za;
}

interface SpawnResult { code: number | null; stdout: string; stdoutBytes: Buffer; stderr: string; timedOut: boolean; cancelled: boolean; spawnError?: Error }

/**
 * 跑一次 7za，stdin 关闭（防止交互式索要密码），输出全量收集。
 * 取消/超时：立刻 SIGKILL 子进程（否则 7za 可能在损坏包上挂住，把整个流水线拖死）。
 * 注意：输出全量进内存（Buffer.concat）——这是 7z 读路径的固有成本，见审计报告。
 */
function run7za(args: string[], opts: { deadline?: Deadline | null; timeoutMs?: number } = {}): Promise<SpawnResult> {
  const bin = resolve7za();
  const deadline = opts.deadline ?? null;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ code: null, stdout: "", stdoutBytes: Buffer.alloc(0), stderr: "", timedOut: false, cancelled: false, spawnError: err as Error });
      return;
    }
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let stop: "cancel" | "deadline" | "timeout" | null = null;
    const kill = (reason: "cancel" | "deadline" | "timeout") => {
      if (!stop) stop = reason;
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    };
    let offStop: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (deadline) {
      offStop = deadline.onStop(() => {
        const err = deadline.errorNow();
        kill(err && isCancelledError(err) ? "cancel" : "deadline");
      });
      // 只在设了 timeoutMs 时挂定时器：只有 signal 的 deadline，remainingMs() 是 null，
      // 若按 null??0 处理会在 spawn 后立刻被杀（实测 bug：abort 测试拿到 TIMEOUT 而不是 CANCELLED）
      const ms = deadline.remainingMs();
      if (ms !== null) {
        timer = setTimeout(() => kill("deadline"), ms);
        timer.unref?.();
      }
    } else {
      timer = setTimeout(() => kill("timeout"), opts.timeoutMs ?? SEVEN_ZIP_TIMEOUT_MS);
      timer.unref?.();
    }
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (offStop) { offStop(); offStop = null; }
    };
    child.stdout?.on("data", (c: Buffer) => outChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => errChunks.push(c));
    child.on("error", (err) => {
      cleanup();
      resolve({ code: null, stdout: "", stdoutBytes: Buffer.alloc(0), stderr: "", timedOut: false, cancelled: false, spawnError: err });
    });
    child.on("close", (code) => {
      cleanup();
      const stdoutBytes = Buffer.concat(outChunks);
      resolve({
        code,
        stdout: stdoutBytes.toString("utf8"),
        stdoutBytes,
        stderr: Buffer.concat(errChunks).toString("utf8"),
        timedOut: stop === "deadline" || stop === "timeout",
        cancelled: stop === "cancel",
      });
    });
  });
}

/** 7za -slt 输出的一条记录。 */
export interface SevenZipEntry { path: string; size: number; isDir: boolean; crc: number | null; encrypted: boolean; packedSize: number | null }

/**
 * 解析 `7za l -slt` 输出。
 * 结构：archive props → 一行 "----------" → 每条目一段 "Key = Value"，段间空行；
 * solid 包/多卷会有多段 "----------"，每段后的 Path 记录仍是条目。
 */
export function parse7zaList(stdout: string): { entries: SevenZipEntry[]; archiveProps: Record<string, string>; encrypted: boolean } {
  const lines = stdout.split(/\r?\n/);
  const entries: SevenZipEntry[] = [];
  const archiveProps: Record<string, string> = {};
  let inEntries = false;
  let rec: Record<string, string> = {};
  let encrypted = false;
  const flush = () => {
    if (Object.keys(rec).length === 0) return;
    const path = rec["Path"];
    const looksLikeEntry = typeof path === "string" && (rec["Size"] !== undefined || rec["Folder"] !== undefined || rec["Attributes"] !== undefined || rec["Packed Size"] !== undefined);
    if (inEntries && looksLikeEntry) {
      const size = Number(rec["Size"] ?? 0);
      const attrs = rec["Attributes"] ?? "";
      const isDir = rec["Folder"] === "+" || /^D/i.test(attrs) || rec["Folder"] === "1";
      const crcRaw = (rec["CRC"] ?? "").trim();
      let crc: number | null = null;
      if (/^[0-9A-Fa-f]{1,8}$/.test(crcRaw)) crc = parseInt(crcRaw, 16) >>> 0;
      const enc = rec["Encrypted"] === "+" || rec["Encrypted"] === "1";
      const packedRaw = (rec["Packed Size"] ?? "").trim();
      const packedNum = Number(packedRaw);
      const packedSize = /^\d+$/.test(packedRaw) && Number.isFinite(packedNum) ? packedNum : null;
      if (enc) encrypted = true;
      entries.push({ path: String(path).replace(/\\/g, "/"), size: Number.isFinite(size) ? size : 0, isDir, crc, encrypted: enc, packedSize });
    } else {
      for (const [k, v] of Object.entries(rec)) if (archiveProps[k] === undefined) archiveProps[k] = v;
      if (rec["Encrypted"] === "+" || rec["Encrypted"] === "1") encrypted = true;
    }
    rec = {};
  };
  for (const line of lines) {
    if (/^-{3,}\s*$/.test(line)) { flush(); inEntries = true; continue; }
    if (line.trim() === "") { flush(); continue; }
    const m = /^([^=]+?)\s*=\s?(.*)$/.exec(line);
    if (m) { rec[m[1].trim()] = m[2]; }
    // 非 k=v 行（"Listing archive:" 等）直接忽略
  }
  flush();
  // 7z 全头加密时 archive props 里可能出现 Encrypted = +
  if (archiveProps["Encrypted"] === "+") encrypted = true;
  return { entries, archiveProps, encrypted };
}

const PASSWORD_RE = /wrong password|can not open encrypted archive|is encrypted|password is required|enter password|encrypted/i;
const NOT_ARCHIVE_RE = /can not open the file as archive|is not supported archive|unsupported method|cannot open the file as|can not open file as|unexpected end of data|is not archive/i;

/** 把 7za 的失败输出翻译成可判别错误；命中加密特征时返回 null 交给调用方处理。 */
function sevenZipFailureToError(res: SpawnResult, file: string, action: string): AppError | null {
  const text = `${res.stdout}\n${res.stderr}`.trim();
  const tail = text.slice(-600);
  if (res.spawnError) return new AppError("INVALID_INPUT", `7za spawn failed: ${res.spawnError.message}`, 400);
  if (res.timedOut) return new AppError("NOT_AN_ARCHIVE", `7za ${action} timed out after ${SEVEN_ZIP_TIMEOUT_MS}ms: ${file}`, 400);
  if (PASSWORD_RE.test(text)) return null; // 加密：调用方决定 return-in-listing 还是 ARCHIVE_PASSWORD
  if (NOT_ARCHIVE_RE.test(text)) return new AppError("NOT_AN_ARCHIVE", `not a readable archive (${file}): ${tail}`, 400);
  return new AppError("NOT_AN_ARCHIVE", `7za ${action} failed (exit ${res.code}) for ${file}: ${tail}`, 400);
}

/** 7za 被取消/超时打断时的统一翻译（优先于通用错误）。 */
function stopError(res: SpawnResult, what: string): AppError | null {
  if (res.cancelled) return new CancelledError(`cancelled: ${what}`);
  if (res.timedOut) return new TimeoutError(`timed out: ${what}`);
  return null;
}

/** rar 专用：7za 无 RAR codec，走 node-unrar-js（未装时抛可判别错误）。 */
async function listRarArchive(file: string, st: ListingState, deadline: Deadline | null): Promise<void> {
  const r = await listRar(file, {
    deadline,
    maxEntries: st.maxEntries,
    maxTotalBytes: st.maxTotalBytes,
    maxEntryBytes: st.maxEntryBytes,
    maxCompressionRatio: st.maxRatio,
  });
  for (const e of r.entries) {
    if (!addEntry(st, { path: e.path, size: e.size, isDir: e.isDir, crc: e.crc })) break;
  }
  if (r.truncated) st.truncated = true;
  if (r.limited && !st.limited) st.limited = r.limited;
  if (r.passwordProtected) st.passwordProtected = true;
  if (r.note) st.notes.push(r.note);
}

async function listSevenZip(file: string, container: "7z" | "rar", st: ListingState, deadline: Deadline | null): Promise<void> {
  const res = await run7za(["l", "-slt", "-p", "--", file], { deadline });
  const stopped = stopError(res, `7za list ${file}`);
  if (stopped) throw stopped;
  if (res.code !== 0) {
    const translated = sevenZipFailureToError(res, file, "list");
    if (!translated) {
      st.passwordProtected = true;
      st.notes.push(`password-protected ${container}: 7za refused to list without a password`);
      return;
    }
    throw translated;
  }
  const { entries: parsed, encrypted } = parse7zaList(res.stdout);
  if (encrypted) {
    st.passwordProtected = true;
    st.notes.push(`${container} has encrypted entries (listed header only)`);
  }
  for (const e of parsed) {
    deadline?.check();
    if (!addEntry(st, { path: e.path, size: e.size, isDir: e.isDir, crc: e.crc }, e.packedSize)) break;
  }
}

/**
 * 用 `7za l -slt -spd -- <archive> <entry>` 精确查一个条目（只读头，不解压）。
 * 必要性：7za 对**不存在的条目** extract 时 exit=0 且 stdout/stderr 全空（实测），
 * 仅凭解包结果无法区分"条目不存在"与"条目就是 0 字节"，必须先 stat。
 */
async function statSevenZipEntry(file: string, entryPath: string, deadline: Deadline | null): Promise<{ size: number; isDir: boolean; encrypted: boolean } | null> {
  const res = await run7za(["l", "-slt", "-p", "-spd", "--", file, entryPath], { deadline });
  const stopped = stopError(res, `7za stat ${file}`);
  if (stopped) throw stopped;
  if (res.code !== 0) {
    const t = sevenZipFailureToError(res, file, "list");
    if (t) throw t;
    return null; // 加密头（无法列出）→ 交给调用方报 ARCHIVE_PASSWORD
  }
  const { entries } = parse7zaList(res.stdout);
  const normalized = entryPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const hit = entries.find((e) => e.path.replace(/\/+$/, "") === normalized);
  return hit ? { size: hit.size, isDir: hit.isDir, encrypted: hit.encrypted } : null;
}

async function readSevenZipEntry(file: string, container: "7z" | "rar", entryPath: string, maxBytes: number, deadline: Deadline | null): Promise<Buffer> {
  const stat = await statSevenZipEntry(file, entryPath, deadline);
  if (!stat) throw new AppError("NOT_FOUND", `entry not found in ${container}: ${entryPath}`, 404);
  if (stat.isDir) throw new AppError("INVALID_INPUT", `entry is a directory: ${entryPath}`, 400);
  if (stat.encrypted) throw new AppError("ARCHIVE_PASSWORD", `${container} entry is encrypted: ${entryPath}`, 400);
  if (stat.size > maxBytes) throw new LimitError("BYTES", `entry too large: ${stat.size} bytes > maxBytes ${maxBytes}`);
  // -so: 解到 stdout；-spd: 关闭通配符（样本文件名含 [ ] ! 等通配字符）；-bd: 关进度
  const res = await run7za(["x", "-so", "-y", "-bd", "-p", "-spd", "--", file, entryPath], { deadline });
  const stopped = stopError(res, `7za extract ${file}:${entryPath}`);
  if (stopped) throw stopped;
  if (res.code !== 0) {
    const translated = sevenZipFailureToError(res, file, "extract");
    if (!translated) throw new AppError("ARCHIVE_PASSWORD", `${container} entry is encrypted: ${entryPath}`, 400);
    throw translated;
  }
  if (res.stdoutBytes.length !== stat.size) {
    throw new AppError(
      "NOT_AN_ARCHIVE",
      `7za ${container} extract size mismatch for ${entryPath}: got ${res.stdoutBytes.length}, declared ${stat.size}`,
      400,
    );
  }
  return res.stdoutBytes;
}

// ---------------------------------------------------------------- 公共 API

export interface ListArchiveOptions extends AbortOptions {
  /** 最多列出多少条（默认 20000）。超出 → truncated + limited.code=ENTRIES */
  maxEntries?: number;
  /** 单条目声明字节上限：超过只标记 limited（仍列出，目录要完整） */
  maxEntryBytes?: number;
  /** 列出条目声明字节合计上限：超出 → 停止并标 limited.code=BYTES */
  maxTotalBytes?: number;
  /** 声明字节 / 压缩字节 的比值上限：超过标 limited.code=RATIO（不停） */
  maxCompressionRatio?: number;
}

export interface ArchiveListingResult extends ArchiveListing {
  /** 命中的第一个上限（null = 完整列出）；流水线据此降级并允许调大限制后重跑 */
  limited: ListingLimit | null;
  /** 已列出条目的声明字节合计（不含被跳过的危险条目） */
  bytesListed: number;
}

export interface ReadEntryOptions extends AbortOptions { /* timeoutMs / signal */ }

/**
 * listArchive：列出 zip/7z/rar 内条目。
 * - 加密包 → { passwordProtected: true, entries: [], note }（rar/7z 头加密时无法列目录）
 * - 条目数 > maxEntries → truncated: true（+ limited）
 * - 损坏/非包/不存在 → AppError("NOT_AN_ARCHIVE" | "NOT_FOUND")
 * - 取消/超时 → **不抛**，返回已列出的部分 + limited.code=CANCELLED/TIMEOUT（列表可降级）
 */
export async function listArchive(file: string, opts: ListArchiveOptions = {}): Promise<ArchiveListingResult> {
  assertReadableFile(file);
  const container = detectContainer(file);
  const st = makeState(opts);
  const deadline = deadlineOf(opts, `listArchive ${file}`);
  try {
    if (container === null) {
      throw new AppError("NOT_AN_ARCHIVE", `unrecognised container (no known magic, no known extension): ${file}`, 400);
    }
    if (container === "unitypackage") {
      throw new AppError("NOT_AN_ARCHIVE", `${file} is a unitypackage; use listUnityPackage() from unitypackage.ts`, 400);
    }
    if (container === "zip") await listZipWithPassword(file, st, deadline);
    else if (container === "rar") await listRarArchive(file, st, deadline);
    else if (container === "7z") await listSevenZip(file, container, st, deadline);
    else throw new AppError("NOT_AN_ARCHIVE", `unsupported container ${container}: ${file}`, 400);
    // 老字段兜底：zip 的加密标志（per-entry 已置位时跳过）
    if (container === "zip" && !st.passwordProtected) {
      const enc = zipCentralDirectoryEncrypted(file);
      if (enc === true) {
        st.passwordProtected = true;
        st.notes.push("zip has encrypted entries (central directory flag set)");
      }
    }
  } catch (err) {
    const limit = limitFromStop(err);
    if (!limit) throw err;
    st.limited = limit;
    st.truncated = true;
  } finally {
    deadline?.dispose();
  }
  return {
    container: container as ContainerKind,
    entries: st.entries,
    truncated: st.truncated,
    passwordProtected: st.passwordProtected,
    ...(st.notes.length ? { note: st.notes.join("; ") } : {}),
    limited: st.limited,
    bytesListed: st.bytesListed,
  };
}

/**
 * readArchiveEntry：直读包内单条目（图片/文本预览用）。
 * - maxBytes 默认 64 MiB；声明/实际大小超过 → LimitError(code="BYTES")，不 OOM
 * - 加密条目 → AppError("ARCHIVE_PASSWORD")
 * - 条目不存在 → AppError("NOT_FOUND")
 * - 取消/超时 → AppError("CANCELLED" | "TIMEOUT")（7za 子进程会被 SIGKILL）
 */
export async function readArchiveEntry(file: string, entryPath: string, maxBytes?: number, opts: ReadEntryOptions = {}): Promise<Buffer> {
  assertReadableFile(file);
  if (typeof entryPath !== "string" || entryPath.length === 0) {
    throw new AppError("INVALID_INPUT", "readArchiveEntry: entryPath is required", 400);
  }
  const cap = Math.floor(maxBytes ?? DEFAULT_MAX_ENTRY_BYTES);
  if (!Number.isFinite(cap) || cap <= 0) throw new AppError("INVALID_INPUT", `readArchiveEntry: maxBytes must be positive (got ${maxBytes})`, 400);
  const container = detectContainer(file);
  const deadline = deadlineOf(opts, `readArchiveEntry ${file}:${entryPath}`);
  try {
    deadline?.check();
    if (container === "zip") return await readZipEntry(file, entryPath.replace(/\\/g, "/"), cap, deadline);
    if (container === "rar") return await readRarEntry(file, entryPath, cap, { deadline });
    if (container === "7z") return await readSevenZipEntry(file, container, entryPath, cap, deadline);
    throw new AppError("NOT_AN_ARCHIVE", `unsupported container for ${file}: ${container ?? "unknown"}`, 400);
  } finally {
    deadline?.dispose();
  }
}

/** 低层导出（测试/交叉校验用）：绕开分派，强制用 7za 列目录。 */
export async function listArchiveWith7zip(file: string, container: "7z" | "rar" | "zip", maxEntries: number): Promise<ArchiveListingResult> {
  const st = makeState({ maxEntries });
  try {
    await listSevenZip(file, container === "zip" ? "7z" : container, st, null);
  } catch (err) {
    const limit = limitFromStop(err);
    if (!limit) throw err;
    st.limited = limit;
    st.truncated = true;
  }
  return {
    container: container === "zip" ? "zip" : container,
    entries: st.entries,
    truncated: st.truncated,
    passwordProtected: st.passwordProtected,
    ...(st.notes.length ? { note: st.notes.join("; ") } : {}),
    limited: st.limited,
    bytesListed: st.bytesListed,
  };
}

/** 低层导出（测试/交叉校验用）：绕开分派，强制用 7za 解单个条目（对 zip 也适用）。 */
export async function readArchiveEntryWith7zip(file: string, container: "7z" | "rar" | "zip", entryPath: string, maxBytes: number): Promise<Buffer> {
  return readSevenZipEntry(file, container === "zip" ? "7z" : container, entryPath, maxBytes, null);
}

/** 低层导出（测试用）：判断扩展名/魔数之外的原始分派结果。 */
export function archiveKindOf(file: string): ContainerKind | null { return detectContainer(file); }
