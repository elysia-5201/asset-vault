/**
 * ZIP 中央目录直读后端（core-content 所有）
 *
 * 为什么需要它：node-stream-zip 的 validateName() 只要条目名里有反斜杠就抛
 * `Malicious entry: ...`，**整包列目录直接失败**。而现实里 Windows 工具（Minecraft 备份、
 * 老式压缩软件）生成的 zip 普遍用 "\" 作分隔符——本机样本
 * <win-drive>/IDM/.../1.12.2-Forge.../2026-06-07-16-17-52.zip 的 901 个条目**全部**是反斜杠名。
 * 若按"不安全就跳过"处理，这个包会变成 0 条目（等于不可用）。因此本模块：
 *   1) 自己解析中央目录（EOCD / ZIP64 EOCD），完全不依赖 node-stream-zip 的校验；
 *   2) 把 "\" 归一化成 "/"（归一化后不再有 Windows 路径穿越面），记 backslashNormalized；
 *   3) 只跳过**真正的**危险路径：绝对路径 "/x"、盘符 "C:x"、含 ".." 段、空名 —— 记 unsafeSkipped；
 *   4) 单条目读取自己实现（local header + inflateRawSync），因为 node-stream-zip 此时也建不出条目表。
 *
 * 安全边界：本模块只把路径当**字符串标识**（进 DB/展示），从不按它落盘；归一化 + 跳危险项
 * 已经足以避免 Windows 解压式穿越。
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { AppError, type ArchiveEntry } from "../contracts";

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

export interface CdScan {
  entries: CdEntry[];
  /** 被跳过的真正危险条目数 */
  unsafeSkipped: number;
  /** 反斜杠被归一化的条目数 */
  backslashNormalized: number;
  passwordProtected: boolean;
  encoding: string;
  zip64: boolean;
}

/**
 * 解析中央目录，返回**安全**条目（危险项只计数不返回）。
 * 结构性问题（没有 EOCD / 签名不对 / 截断）→ AppError("NOT_AN_ARCHIVE")。
 */
export function scanZipCentralDirectory(file: string): CdScan {
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
    let backslashNormalized = 0;
    let passwordProtected = false;
    let encoding = "utf8";
    let p = 0;
    let seen = 0;
    while (p + 46 <= cd.length && seen < entryCount) {
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

      const normalized = rawName.replace(/\\/g, "/");
      const hadBackslash = rawName.includes("\\");
      const isDir = normalized.endsWith("/") || ((externalAttr >>> 16) & 0x10) !== 0;
      const path = normalized.replace(/\/+$/, "");
      const unsafe =
        forcedUnsafe(rawName) ||
        normalized.startsWith("/") ||
        /^[A-Za-z]:/.test(normalized) ||
        normalized.split("/").some((seg) => seg === "..") ||
        path.length === 0;

      if (unsafe) unsafeSkipped++;
      else {
        if (hadBackslash) backslashNormalized++;
        entries.push({ path, size: usize, compressedSize: csize, crc, isDir, encrypted: (flags & 1) !== 0, method, localOffset });
      }
      p += 46 + namelen + extralen + commentlen;
      seen++;
    }
    return { entries, unsafeSkipped, backslashNormalized, passwordProtected, encoding, zip64 };
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** 显式的危险模式（先于归一化判断）。 */
function forcedUnsafe(rawName: string): boolean {
  return /^[A-Za-z]:/.test(rawName) || rawName.startsWith("\\\\") || rawName.startsWith("/");
}

/** 单条目读取：local header + 解压（store / deflate）。用于 node-stream-zip 建不出表的包。 */
export function readZipEntryFromCentralDirectory(file: string, entryPath: string, maxBytes: number): Buffer {
  const scan = scanZipCentralDirectory(file);
  const wanted = entryPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const e = scan.entries.find((x) => x.path === wanted);
  if (!e) throw new AppError("NOT_FOUND", `entry not found in zip (central directory): ${entryPath}`, 404);
  if (e.isDir) throw new AppError("INVALID_INPUT", `entry is a directory: ${entryPath}`, 400);
  if (e.encrypted) throw new AppError("ARCHIVE_PASSWORD", `zip entry is encrypted: ${entryPath}`, 400);
  if (e.size > maxBytes) throw new AppError("INVALID_INPUT", `entry too large: ${e.size} bytes > maxBytes ${maxBytes}`, 400);
  let fd: number;
  try { fd = openSync(file, "r"); } catch { throw new AppError("NOT_FOUND", `archive not found: ${file}`, 404); }
  try {
    const lh = readAt(fd, e.localOffset, 30);
    if (lh.readUInt32LE(0) !== LFH_SIG) throw new AppError("NOT_AN_ARCHIVE", `zip: bad local header for ${entryPath}`, 400);
    const namelen = lh.readUInt16LE(26);
    const extralen = lh.readUInt16LE(28);
    const dataStart = e.localOffset + 30 + namelen + extralen;
    const raw = readAt(fd, dataStart, e.compressedSize, Math.max(maxBytes * 2, 64 * 1024 * 1024));
    let out: Buffer;
    if (e.method === 0) out = raw;
    else if (e.method === 8) {
      try { out = inflateRawSync(raw); } catch (err) {
        throw new AppError("NOT_AN_ARCHIVE", `zip: inflate failed for ${entryPath}: ${(err as Error).message}`, 400);
      }
    } else {
      throw new AppError("INVALID_INPUT", `zip: unsupported compression method ${e.method} for ${entryPath}`, 400);
    }
    if (out.length !== e.size) {
      throw new AppError("NOT_AN_ARCHIVE", `zip: size mismatch for ${entryPath}: got ${out.length}, declared ${e.size}`, 400);
    }
    return out;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** 把扫描结果转成统一的 ArchiveEntry 列表（含 maxEntries 截断）。 */
export function listFromScan(scan: CdScan, maxEntries: number): { entries: ArchiveEntry[]; truncated: boolean } {
  const truncated = scan.entries.length > maxEntries;
  return {
    entries: scan.entries.slice(0, maxEntries).map((e) => ({ path: e.path, size: e.size, isDir: e.isDir, crc: e.crc })),
    truncated,
  };
}
