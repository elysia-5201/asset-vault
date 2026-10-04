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
 */
import { spawn } from "node:child_process";
import { accessSync, chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, mkdtempSync, openSync, readSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { AppError, type ArchiveEntry, type ArchiveListing, type ContainerKind } from "../contracts";
import { listRar, readRarEntry } from "./rar";
import { listFromScan, nameScore, readZipEntryFromCentralDirectory, scanZipCentralDirectory } from "./zip-cd";

const require_ = createRequire(import.meta.url);

/** 单条目读取的默认字节上限（64 MiB）：超过即抛 INVALID_INPUT，绝不 OOM。 */
export const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** listArchive 默认列出的最大条目数（防止超大包把内存/DB 打满）。 */
export const DEFAULT_MAX_ENTRIES = 20000;
/** 7za 单次调用的超时（毫秒）：损坏包可能让工具挂住。 */
const SEVEN_ZIP_TIMEOUT_MS = 120_000;

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
 */
type ZipEncoding = "utf8" | "shift_jis" | "gbk" | "cp437";
const zipEncodingCache = new Map<string, ZipEncoding>();
const NAME_ENCODING_CANDIDATES: readonly ZipEncoding[] = ["shift_jis", "gbk", "cp437"];

// nameScore / 编码打分口径见 ./zip-cd.ts（单一实现，两条 zip 路径共用，避免双实现漂移）

interface DecodedZip { zip: any; entries: Record<string, ZipEntryLike>; encoding: ZipEncoding; note?: string }

async function openZipDecoded(file: string): Promise<DecodedZip> {
  const StreamZip = loadStreamZip();
  const cached = zipEncodingCache.get(file);
  const opts = (enc: ZipEncoding) => ({ file, ...(enc === "utf8" ? {} : { nameEncoding: enc }) });
  if (cached) {
    const zip = new StreamZip.async(opts(cached));
    return { zip, entries: (await zip.entries()) as Record<string, ZipEntryLike>, encoding: cached };
  }
  let zip = new StreamZip.async(opts("utf8"));
  let entries = (await zip.entries()) as Record<string, ZipEntryLike>;
  const baseBad = nameScore(Object.keys(entries));
  if (baseBad === 0) {
    zipEncodingCache.set(file, "utf8");
    return { zip, entries, encoding: "utf8" };
  }
  let best: { enc: ZipEncoding; zip: any; entries: Record<string, ZipEntryLike>; bad: number } | null = null;
  for (const enc of NAME_ENCODING_CANDIDATES) {
    let z: any;
    try {
      z = new StreamZip.async(opts(enc));
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

async function listZip(file: string, maxEntries: number): Promise<ArchiveListing> {
  let zip: any;
  try {
    const opened = await openZipDecoded(file);
    zip = opened.zip;
    const raw = opened.entries;
    const entries: ArchiveEntry[] = [];
    let truncated = false;
    let passwordProtected = false;
    for (const e of Object.values(raw)) {
      if (e.encrypted) passwordProtected = true;
      if (entries.length >= maxEntries) { truncated = true; continue; }
      entries.push({
        // 目录条目统一去掉尾部 "/"（7za/rar 后端的 Path 本来就不带），靠 isDir 表达类型
        path: e.name.replace(/\\/g, "/").replace(/\/+$/, ""),
        size: Number(e.size ?? 0),
        isDir: e.isDirectory === true || (e.isFile === false && e.name.endsWith("/")),
        crc: typeof e.crc === "number" ? e.crc >>> 0 : null,
      });
    }
    const enc = zipCentralDirectoryEncrypted(file);
    if (enc === true) passwordProtected = true;
    const notes: string[] = [];
    if (passwordProtected) notes.push("zip has encrypted entries (central directory flag set)");
    if (opened.note) notes.push(opened.note);
    return { container: "zip", entries, truncated, passwordProtected, ...(notes.length ? { note: notes.join("; ") } : {}) };
  } catch (err) {
    // node-stream-zip 的 validateName() 见到任何含 "\\" 的条目名就抛 "Malicious entry"，
    // 整包列目录失败。现实里 Windows 工具生成的 zip 普遍如此（本机样本 901/901 条）。
    // 回退到自研中央目录解析：反斜杠归一化为 "/"，只跳过真正危险的（绝对路径/盘符/..）。
    if (isMaliciousEntryError(err)) return listZipViaCentralDirectory(file, maxEntries);
    throw translateArchiveError(err, file, "zip");
  } finally {
    try { if (zip) await zip.close(); } catch { /* ignore */ }
  }
}

function isMaliciousEntryError(err: unknown): boolean {
  return /malicious entry/i.test((err as Error)?.message ?? "");
}

/** 中央目录回退路径：可列出、note 里说明归一化了多少条、跳过了多少条危险项。 */
function listZipViaCentralDirectory(file: string, maxEntries: number): ArchiveListing {
  const scan = scanZipCentralDirectory(file);
  const { entries, truncated } = listFromScan(scan, maxEntries);
  const notes: string[] = [];
  if (scan.backslashNormalized > 0) notes.push(`normalized ${scan.backslashNormalized} backslash paths to "/"`);
  if (scan.unsafeSkipped > 0) notes.push(`skipped ${scan.unsafeSkipped} unsafe entries`);
  if (scan.encoding !== "utf8") notes.push(`legacy zip filename encoding decoded as ${scan.encoding}`);
  if (scan.zip64) notes.push("zip64 archive");
  if (notes.length === 0) notes.push("listed via central directory fallback");
  return { container: "zip", entries, truncated, passwordProtected: scan.passwordProtected, note: notes.join("; ") };
}

async function readZipEntry(file: string, entryPath: string, maxBytes: number): Promise<Buffer> {
  let zip: any;
  try {
    const opened = await openZipDecoded(file);
    zip = opened.zip;
    const e = (await zip.entry(entryPath)) as ZipEntryLike | undefined;
    if (!e) throw new AppError("NOT_FOUND", `entry not found in zip: ${entryPath}`, 404);
    if (e.isDirectory) throw new AppError("INVALID_INPUT", `entry is a directory: ${entryPath}`, 400);
    const declared = Number(e.size ?? 0);
    if (declared > maxBytes) {
      throw new AppError("INVALID_INPUT", `entry too large: ${declared} bytes > maxBytes ${maxBytes}`, 400);
    }
    const data = (await zip.entryData(entryPath)) as Buffer;
    if (data.length > maxBytes) {
      throw new AppError("INVALID_INPUT", `entry too large: ${data.length} bytes > maxBytes ${maxBytes}`, 400);
    }
    return data;
  } catch (err) {
    // 与 listArchive 同一原因：这类包 node-stream-zip 建不出条目表 → 走自研 CD 直读
    if (isMaliciousEntryError(err)) return readZipEntryFromCentralDirectory(file, entryPath, maxBytes);
    if (err instanceof AppError) throw err;
    throw translateArchiveError(err, file, "zip", entryPath);
  } finally {
    try { if (zip) await zip.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- 7z / rar (7zip-bin)

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

interface SpawnResult { code: number | null; stdout: string; stdoutBytes: Buffer; stderr: string; timedOut: boolean; spawnError?: Error }

/** 跑一次 7za，stdin 关闭（防止交互式索要密码），有超时，输出全量收集。 */
function run7za(args: string[], opts?: { timeoutMs?: number }): Promise<SpawnResult> {
  const bin = resolve7za();
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ code: null, stdout: "", stdoutBytes: Buffer.alloc(0), stderr: "", timedOut: false, spawnError: err as Error });
      return;
    }
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts?.timeoutMs ?? SEVEN_ZIP_TIMEOUT_MS);
    child.stdout?.on("data", (c: Buffer) => outChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => errChunks.push(c));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout: "", stdoutBytes: Buffer.alloc(0), stderr: "", timedOut, spawnError: err });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdoutBytes = Buffer.concat(outChunks);
      resolve({
        code,
        stdout: stdoutBytes.toString("utf8"),
        stdoutBytes,
        stderr: Buffer.concat(errChunks).toString("utf8"),
        timedOut,
      });
    });
  });
}

/** 7za -slt 输出的一条记录。 */
export interface SevenZipEntry { path: string; size: number; isDir: boolean; crc: number | null; encrypted: boolean }

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
      if (enc) encrypted = true;
      entries.push({ path: String(path).replace(/\\/g, "/"), size: Number.isFinite(size) ? size : 0, isDir, crc, encrypted: enc });
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

/** rar 专用：7za 无 RAR codec，走 node-unrar-js（未装时抛可判别错误）。 */
async function listRarArchive(file: string, maxEntries: number): Promise<ArchiveListing> {
  const r = await listRar(file, maxEntries);
  return {
    container: "rar",
    entries: r.entries.map((e) => ({ path: e.path, size: e.size, isDir: e.isDir, crc: e.crc })),
    truncated: r.truncated,
    passwordProtected: r.passwordProtected,
    ...(r.note ? { note: r.note } : {}),
  };
}

async function listSevenZip(file: string, container: "7z" | "rar", maxEntries: number): Promise<ArchiveListing> {
  const res = await run7za(["l", "-slt", "-p", "--", file]);
  if (res.code !== 0) {
    const translated = sevenZipFailureToError(res, file, "list");
    if (!translated) {
      return {
        container,
        entries: [],
        truncated: false,
        passwordProtected: true,
        note: `password-protected ${container}: 7za refused to list without a password`,
      };
    }
    throw translated;
  }
  const { entries: parsed, encrypted } = parse7zaList(res.stdout);
  let truncated = false;
  let entries = parsed;
  if (entries.length > maxEntries) { entries = entries.slice(0, maxEntries); truncated = true; }
  const note = encrypted ? `${container} has encrypted entries (listed header only)` : undefined;
  return {
    container,
    entries: entries.map((e) => ({ path: e.path, size: e.size, isDir: e.isDir, crc: e.crc })),
    truncated,
    passwordProtected: encrypted,
    ...(note ? { note } : {}),
  };
}

/**
 * 用 `7za l -slt -spd -- <archive> <entry>` 精确查一个条目（只读头，不解压）。
 * 必要性：7za 对**不存在的条目** extract 时 exit=0 且 stdout/stderr 全空（实测），
 * 仅凭解包结果无法区分"条目不存在"与"条目就是 0 字节"，必须先 stat。
 */
async function statSevenZipEntry(file: string, entryPath: string): Promise<{ size: number; isDir: boolean; encrypted: boolean } | null> {
  const res = await run7za(["l", "-slt", "-p", "-spd", "--", file, entryPath]);
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

async function readSevenZipEntry(file: string, container: "7z" | "rar", entryPath: string, maxBytes: number): Promise<Buffer> {
  const stat = await statSevenZipEntry(file, entryPath);
  if (!stat) throw new AppError("NOT_FOUND", `entry not found in ${container}: ${entryPath}`, 404);
  if (stat.isDir) throw new AppError("INVALID_INPUT", `entry is a directory: ${entryPath}`, 400);
  if (stat.encrypted) throw new AppError("ARCHIVE_PASSWORD", `${container} entry is encrypted: ${entryPath}`, 400);
  if (stat.size > maxBytes) throw new AppError("INVALID_INPUT", `entry too large: ${stat.size} bytes > maxBytes ${maxBytes}`, 400);
  // -so: 解到 stdout；-spd: 关闭通配符（样本文件名含 [ ] ! 等通配字符）；-bd: 关进度
  const res = await run7za(["x", "-so", "-y", "-bd", "-p", "-spd", "--", file, entryPath]);
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

/**
 * listArchive：列出 zip/7z/rar 内条目。
 * - 加密包 → { passwordProtected: true, entries: [], note }（rar/7z 头加密时无法列目录）
 * - 条目数 > maxEntries → truncated: true
 * - 损坏/非包/不存在 → AppError("NOT_AN_ARCHIVE" | "NOT_FOUND")
 */
export async function listArchive(file: string, opts?: { maxEntries?: number }): Promise<ArchiveListing> {
  assertReadableFile(file);
  const container = detectContainer(file);
  const maxEntries = Math.max(1, Math.floor(opts?.maxEntries ?? DEFAULT_MAX_ENTRIES));
  if (container === null) {
    throw new AppError("NOT_AN_ARCHIVE", `unrecognised container (no known magic, no known extension): ${file}`, 400);
  }
  if (container === "unitypackage") {
    throw new AppError("NOT_AN_ARCHIVE", `${file} is a unitypackage; use listUnityPackage() from unitypackage.ts`, 400);
  }
  if (container === "zip") return listZip(file, maxEntries);
  if (container === "rar") return listRarArchive(file, maxEntries);
  if (container === "7z") return listSevenZip(file, container, maxEntries);
  throw new AppError("NOT_AN_ARCHIVE", `unsupported container ${container}: ${file}`, 400);
}

/**
 * readArchiveEntry：直读包内单条目（图片/文本预览用）。
 * - maxBytes 默认 64 MiB；声明/实际大小超过 → AppError("INVALID_INPUT")，不 OOM
 * - 加密条目 → AppError("ARCHIVE_PASSWORD")
 * - 条目不存在 → AppError("NOT_FOUND")
 */
export async function readArchiveEntry(file: string, entryPath: string, maxBytes?: number): Promise<Buffer> {
  assertReadableFile(file);
  if (typeof entryPath !== "string" || entryPath.length === 0) {
    throw new AppError("INVALID_INPUT", "readArchiveEntry: entryPath is required", 400);
  }
  const cap = Math.floor(maxBytes ?? DEFAULT_MAX_ENTRY_BYTES);
  if (!Number.isFinite(cap) || cap <= 0) throw new AppError("INVALID_INPUT", `readArchiveEntry: maxBytes must be positive (got ${maxBytes})`, 400);
  const container = detectContainer(file);
  if (container === "zip") return readZipEntry(file, entryPath.replace(/\\/g, "/"), cap);
  if (container === "rar") return readRarEntry(file, entryPath, cap);
  if (container === "7z") return readSevenZipEntry(file, container, entryPath, cap);
  throw new AppError("NOT_AN_ARCHIVE", `unsupported container for ${file}: ${container ?? "unknown"}`, 400);
}

/** 低层导出（测试/交叉校验用）：绕开分派，强制用 7za 列目录。 */
export const listArchiveWith7zip = listSevenZip;
/** 低层导出（测试/交叉校验用）：绕开分派，强制用 7za 解单个条目（对 zip 也适用）。 */
export const readArchiveEntryWith7zip = readSevenZipEntry;
/** 低层导出（测试用）：判断扩展名/魔数之外的原始分派结果。 */
export function archiveKindOf(file: string): ContainerKind | null { return detectContainer(file); }
