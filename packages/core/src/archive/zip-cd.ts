/**
 * ZIP 中央目录直读后端（core-content 所有）
 *
 * 为什么需要它：node-stream-zip 的 validateName() 只要条目名里有反斜杠就抛
 * `Malicious entry: ...`，**整包列目录直接失败**。而现实里 Windows 工具（Minecraft 备份、
 * 老式压缩软件）生成的 zip 普遍用 "\\" 作分隔符——本机样本
 * <win-drive>/IDM/.../1.12.2-Forge.../2026-06-07-16-17-52.zip 的 901 个条目**全部**是反斜杠名。
 * 若按"不安全就跳过"处理，这个包会变成 0 条目（等于不可用）。因此本模块：
 *   1) 自己解析中央目录（EOCD / ZIP64 EOCD），完全不依赖 node-stream-zip 的校验；
 *   2) 路径统一交给 safeEntryPath（反斜杠→斜杠、拒绝对路径/盘符/UNC/.. /NUL），记 backslashNormalized；
 *   3) 只跳过**真正的**危险路径，记 unsafeSkipped（并保留前几条 reason 便于诊断）；
 *   4) 单条目读取自己实现（local header + inflateRawSync），因为 node-stream-zip 此时也建不出条目表。
 *
 * 安全边界：本模块只把路径当**字符串标识**（进 DB/展示），从不按它落盘；归一化 + 跳危险项
 * 已经足以避免 Windows 解压式穿越。
 *
 * v0.6.0：新增 deadline 检查点（每解析一条中央目录记录）、untilPath 早停（读单条目时不必扫完整个 CD）、
 * 以及上限（条目数/总字节/单条目字节/压缩比）——上限命中时**返回 limited 而不是抛**。
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { AppError } from "../contracts";
import type { Deadline } from "../abort";
import { LimitError, type ListingLimit } from "../limits";
import { safeEntryPath } from "./safepath";

const EOCD_SIG = 0x06054b50;
const EOCD64_LOC_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/** 读文件的 [offset, offset+len) 精确字节；len 过大直接抛（防止被畸形头骗着分配）。 */
function readAt(fd: number, offset: number, len: number, cap = 512 * 1024 * 1024): Buffer {
  if (len < 0 || len > cap) throw new AppError("NOT_AN_ARCHIVE", `zip: implausible read length ${len}`, 400);
  const out = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, out, got, len - got, offset + got);
    if (n <= 0) break;
    got += n;
  }
  if (got !== len) throw new AppError("NOT_AN_ARCHIVE", `zip: truncated read (${got}/${len} @ ${offset})`, 400);
  return out;
}

/** 候选编码打分（越小越好）：U+FFFD 罚 10，半角片假名罚 1（区分 Shift-JIS / GBK 的平局）。 */
export function nameScore(names: string[]): number {
  let score = 0;
  for (const s of names) {
    for (const ch of s) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp === 0xfffd) score += 10;
      else if (cp >= 0xff61 && cp <= 0xff9f) score += 1;
    }
  }
  return score;
}

const LEGACY_ENCODINGS = ["shift_jis", "gbk", "cp437", "cp1252"] as const;

/** 按 UTF-8 标志位解码；没标志位就用候选编码打分挑最优（同 list.ts 的口径）。 */
function decodeName(bytes: Buffer, utf8Flag: boolean): { name: string; encoding: string } {
  if (utf8Flag) return { name: bytes.toString("utf8"), encoding: "utf8" };
  const utf8 = bytes.toString("utf8");
  if (!utf8.includes("\uFFFD")) return { name: utf8, encoding: "utf8" };
  let best = { name: utf8, encoding: "utf8", score: nameScore([utf8]) };
  for (const enc of LEGACY_ENCODINGS) {
    let decoded: string;
    try { decoded = new TextDecoder(enc).decode(bytes); } catch { continue; }
    const score = nameScore([decoded]);
    if (score < best.score) best = { name: decoded, encoding: enc, score };
  }
  return { name: best.name, encoding: best.encoding };
}

export interface CdEntry {
  /** 归一化后的路径（反斜杠→斜杠、去掉目录尾斜杠） */
  path: string;
  size: number;
  compressedSize: number;
  crc: number | null;
  isDir: boolean;
  encrypted: boolean;
  method: number;
  localOffset: number;
}

export interface CdLimits {
  maxEntries?: number;
  maxTotalBytes?: number | null;
  maxEntryBytes?: number | null;
  maxCompressionRatio?: number | null;
}

export interface CdScan {
  entries: CdEntry[];
  /** 被跳过的真正危险条目数 */
  unsafeSkipped: number;
  /** 危险条目的前几条原因（诊断用，避免只报一个数字） */
  unsafeReasons: string[];
  /** 反斜杠被归一化的条目数 */
  backslashNormalized: number;
  passwordProtected: boolean;
  encoding: string;
  zip64: boolean;
  /** 上限命中信息（null = 完整列出） */
  limited: ListingLimit | null;
  /** 已列出的条目声明字节合计 */
  bytesListed: number;
  /** 是否因上限提前停止 */
  truncated: boolean;
}

export interface CdScanOptions {
  /** 取消/截止检查点 */
  deadline?: Deadline | null;
  /** 上限（不传 = 不限制） */
  limits?: CdLimits | null;
  /** 只扫到这个路径为止（读单条目时的早停；命中后仍会返回该条目） */
  untilPath?: string | null;
}

/**
 * 解析中央目录，返回**安全**条目（危险项只计数不返回）。
 * 结构性问题（没有 EOCD / 签名不对 / 截断）→ AppError("NOT_AN_ARCHIVE")。
 * 上限命中 → 提前停止并返回 limited（不抛）。
 */
export function scanZipCentralDirectory(file: string, opts: CdScanOptions = {}): CdScan {
  const deadline = opts.deadline ?? null;
  const lim = opts.limits ?? null;
  const untilPath = opts.untilPath ? opts.untilPath.replace(/\\/g, "/").replace(/\/+$/, "") : null;
  let fd: number;
  try { fd = openSync(file, "r"); } catch { throw new AppError("NOT_FOUND", `archive not found: ${file}`, 404); }
  try {
    const size = fstatSync(fd).size;
    if (size < 22) throw new AppError("NOT_AN_ARCHIVE", `zip too small: ${file}`, 400);
    const tailLen = Math.min(size, 66_000);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new AppError("NOT_AN_ARCHIVE", `zip: no EOCD found (${file})`, 400);
    const eocdAbs = size - tailLen + eocd;
    let entryCount = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    let zip64 = false;
    if (entryCount === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      // ZIP64：EOCD 前 20 字节是 locator
      if (eocdAbs >= 20) {
        const loc = readAt(fd, eocdAbs - 20, 20);
        if (loc.readUInt32LE(0) === EOCD64_LOC_SIG) {
          const z64Off = Number(loc.readBigUInt64LE(8));
          const z64 = readAt(fd, z64Off, 56);
          if (z64.readUInt32LE(0) === EOCD64_SIG) {
            entryCount = Number(z64.readBigUInt64LE(32));
            cdSize = Number(z64.readBigUInt64LE(40));
            cdOffset = Number(z64.readBigUInt64LE(48));
            zip64 = true;
          }
        }
      }
    }
    if (cdOffset + cdSize > size) throw new AppError("NOT_AN_ARCHIVE", `zip: central directory out of range (${file})`, 400);
    const cd = readAt(fd, cdOffset, Math.min(cdSize, 512 * 1024 * 1024));

    const entries: CdEntry[] = [];
    let unsafeSkipped = 0;
    const unsafeReasons: string[] = [];
    let backslashNormalized = 0;
    let passwordProtected = false;
    let encoding = "utf8";
    let limited: ListingLimit | null = null;
    let bytesListed = 0;
    let truncated = false;
    const maxEntries = lim?.maxEntries ?? null;
    const maxTotalBytes = lim?.maxTotalBytes ?? null;
    const maxEntryBytes = lim?.maxEntryBytes ?? null;
    const maxRatio = lim?.maxCompressionRatio ?? null;
    let p = 0;
    let seen = 0;
    while (p + 46 <= cd.length && seen < entryCount) {
      // 检查点：一条中央目录记录一次（大包 90 万条时也能及时刹车）
      deadline?.check();
      if (cd.readUInt32LE(p) !== CD_SIG) break;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const namelen = cd.readUInt16LE(p + 28);
      const extralen = cd.readUInt16LE(p + 30);
      const commentlen = cd.readUInt16LE(p + 32);
      const externalAttr = cd.readUInt32LE(p + 38);
      let localOffset = cd.readUInt32LE(p + 42);
      const nameBytes = cd.subarray(p + 46, p + 46 + namelen);
      const extra = cd.subarray(p + 46 + namelen, p + 46 + namelen + extralen);

      // ZIP64 扩展字段 0x0001：按 usize/csize/localOffset/disk 的顺序填 0xFFFFFFFF 的位
      if (usize === 0xffffffff || csize === 0xffffffff || localOffset === 0xffffffff) {
        let q = 0;
        while (q + 4 <= extra.length) {
          const tag = extra.readUInt16LE(q);
          const len = extra.readUInt16LE(q + 2);
          if (tag === 0x0001) {
            let r = q + 4;
            if (usize === 0xffffffff && r + 8 <= extra.length) { usize = Number(extra.readBigUInt64LE(r)); r += 8; }
            if (csize === 0xffffffff && r + 8 <= extra.length) { csize = Number(extra.readBigUInt64LE(r)); r += 8; }
            if (localOffset === 0xffffffff && r + 8 <= extra.length) { localOffset = Number(extra.readBigUInt64LE(r)); r += 8; }
            break;
          }
          q += 4 + len;
        }
      }

      const decoded = decodeName(nameBytes, (flags & 0x800) !== 0);
      if (decoded.encoding !== "utf8") encoding = decoded.encoding;
      const rawName = decoded.name;
      if (flags & 0x0001) passwordProtected = true;

      const isDir = rawName.endsWith("/") || rawName.endsWith("\\") || ((externalAttr >>> 16) & 0x10) !== 0;
      const safe = safeEntryPath(rawName);
      if (!safe.ok) {
        unsafeSkipped++;
        if (unsafeReasons.length < 5) unsafeReasons.push(`${rawName.slice(0, 80)}: ${safe.reason}`);
      } else {
        const hadBackslash = rawName.includes("\\");
        if (hadBackslash) backslashNormalized++;
        // 上限 1/3：条目数满了就停
        if (maxEntries !== null && entries.length >= maxEntries) {
          truncated = true;
          limited = { code: "ENTRIES", message: `stopped at maxEntries=${maxEntries}` };
          break;
        }
        // 上限 2/3：累计声明字节超了就停（防"1M 条 × 10MB"把内存/DB 打满）
        if (maxTotalBytes !== null && bytesListed + usize > maxTotalBytes) {
          truncated = true;
          limited = { code: "BYTES", message: `bytesListed ${bytesListed} + entry ${usize} > maxTotalBytes ${maxTotalBytes}` };
          break;
        }
        // 上限 3/3：单条目过大 / 压缩比异常 —— 仍然列出（目录要完整），只标记
        if (maxEntryBytes !== null && usize > maxEntryBytes && limited === null) {
          limited = { code: "BYTES", message: `entry ${safe.path.slice(0, 80)} declared ${usize} > maxEntryBytes ${maxEntryBytes}` };
        }
        if (maxRatio !== null && csize > 0 && usize / csize > maxRatio && limited === null) {
          limited = { code: "RATIO", message: `entry ${safe.path.slice(0, 80)} ratio ${(usize / csize).toFixed(1)}:1 > maxCompressionRatio ${maxRatio}` };
        }
        entries.push({ path: safe.path, size: usize, compressedSize: csize, crc, isDir, encrypted: (flags & 1) !== 0, method, localOffset });
        bytesListed += usize;
        if (untilPath !== null && safe.path === untilPath) break;
      }
      p += 46 + namelen + extralen + commentlen;
      seen++;
    }
    return { entries, unsafeSkipped, unsafeReasons, backslashNormalized, passwordProtected, encoding, zip64, limited, bytesListed, truncated };
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

export interface CdReadOptions { deadline?: Deadline | null }

/** 单条目读取：local header + 解压（store / deflate）。用于 node-stream-zip 建不出表的包。 */
export function readZipEntryFromCentralDirectory(file: string, entryPath: string, maxBytes: number, opts: CdReadOptions = {}): Buffer {
  const deadline = opts.deadline ?? null;
  const wanted = entryPath.replace(/\\/g, "/").replace(/\/+$/, "");
  // untilPath：只扫到目标条目，不必解析整个中央目录
  const scan = scanZipCentralDirectory(file, { deadline, untilPath: wanted });
  const e = scan.entries.find((x) => x.path === wanted);
  if (!e) throw new AppError("NOT_FOUND", `entry not found in zip (central directory): ${entryPath}`, 404);
  if (e.isDir) throw new AppError("INVALID_INPUT", `entry is a directory: ${entryPath}`, 400);
  if (e.encrypted) throw new AppError("ARCHIVE_PASSWORD", `zip entry is encrypted: ${entryPath}`, 400);
  if (e.size > maxBytes) throw new LimitError("BYTES", `entry too large: ${e.size} bytes > maxBytes ${maxBytes}`);
  let fd: number;
  try { fd = openSync(file, "r"); } catch { throw new AppError("NOT_FOUND", `archive not found: ${file}`, 404); }
  try {
    deadline?.check();
    const lh = readAt(fd, e.localOffset, 30);
    if (lh.readUInt32LE(0) !== LFH_SIG) throw new AppError("NOT_AN_ARCHIVE", `zip: bad local header for ${entryPath}`, 400);
    const namelen = lh.readUInt16LE(26);
    const extralen = lh.readUInt16LE(28);
    const dataStart = e.localOffset + 30 + namelen + extralen;
    // 压缩数据整块进内存（最多 2×maxBytes 或 64MiB，取大者）——这是当前 read 契约的固有上限
    const raw = readAt(fd, dataStart, e.compressedSize, Math.max(maxBytes * 2, 64 * 1024 * 1024));
    deadline?.check();
    let out: Buffer;
    if (e.method === 0) out = raw;
    else if (e.method === 8) {
      try { out = inflateRawSync(raw); } catch (err) {
        throw new AppError("NOT_AN_ARCHIVE", `zip: inflate failed for ${entryPath}: ${(err as Error).message}`, 400);
      }
    } else {
      throw new AppError("INVALID_INPUT", `zip: unsupported compression method ${e.method} for ${entryPath}`, 400);
    }
    // 声明大小是攻击者可控的：解压后才能校验（见审计结论：解压比守卫应在 list 阶段做）
    if (out.length !== e.size) {
      throw new AppError("NOT_AN_ARCHIVE", `zip: size mismatch for ${entryPath}: got ${out.length}, declared ${e.size}`, 400);
    }
    return out;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** 把扫描结果转成统一的 ArchiveEntry 列表（含 maxEntries 截断）。 */
export function listFromScan(scan: CdScan, maxEntries: number): { entries: { path: string; size: number; isDir: boolean; crc?: number | null }[]; truncated: boolean } {
  const truncated = scan.truncated || scan.entries.length > maxEntries;
  return {
    entries: scan.entries.slice(0, maxEntries).map((e) => ({ path: e.path, size: e.size, isDir: e.isDir, crc: e.crc })),
    truncated,
  };
}
