/**
 * core-content 测试夹具（本文件属 packages/core/test/content/，core-content 所有）
 *
 * 原则：测试既要有"真实样本"证据，也要有"合成样本 + 已知值"对照组——
 * 否则度量可能退化（例：只断言"没抛异常"，任何实现都能过）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";

/**
 * 真实样本根目录：用环境变量指向你自己的素材库即可跑"真实样本"用例；
 * 不设时用占位符（仓库里不写任何本机路径），相关用例自动 SKIP。
 *   AV_SAMPLES_DIR=/path/to/vrchatcache node scripts/test.mjs
 *   AV_DOWNLOADS_DIR=/path/to/downloads
 */
const LIB = process.env.AV_SAMPLES_DIR ?? "%LIBRARY%";
const DL = process.env.AV_DOWNLOADS_DIR ?? "%DOWNLOADS%";

export const SAMPLES = {
  dir: LIB,
  unitypackage: LIB + "/MANUKA_ver1.02/MANUKA.unitypackage",
  zipSmall: LIB + "/素材库/KawaiiPosing_Ver.3.0.3.zip",
  zipNested: LIB + "/素材库/Milky-Way.zip",
  zipJp: LIB + "/素材库/ミルフィちゃん専用テクスチャ.zip",
  sevenZip: LIB + "/素材库/[19 Avatars] citrus shop Soft Texture.7z",
  rar: LIB + "/Shinano/妆造/Shinano_谷間+肌色.rar",
  /** Windows 工具生成的 Minecraft 备份包：901 个条目**全部**用反斜杠分隔（node-stream-zip 会整包拒绝） */
  zipBackslash: DL + "/.minecraft/versions/1.12.2-Forge_14.23.5.2860/backups/2026-06-07-16-17-52.zip",
  /** 已知事实（docs/CONTRACT.md §5）：MANUKA 包 = 165 GUID / 678 tar 条目 / 47 preview */
  manuka: { guids: 165, tarEntries: 678, previews: 47 },
} as const;

export function has(p: string): boolean { return existsSync(p); }

export function tmpDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `avtest-${tag}-`));
}

export function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** 独立的 crc32（IEEE 802.3）——用来核对 7za 解出的字节与其声明的 CRC 是否一致。 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf: Buffer | Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** GNU tar 是否可用（unitypackage 的独立交叉仪器）。 */
export function tarAvailable(): boolean {
  try { execFileSync("tar", ["--version"], { stdio: "pipe" }); return true; } catch { return false; }
}

/** 用 GNU tar 独立数 tar.gz 条目数（与被测解析器无共享代码）。 */
export function gnuTarEntryCount(file: string): number {
  const out = execFileSync("tar", ["tzf", file], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  return out.toString("utf8").split("\n").filter((l) => l.length > 0).length;
}

// ---------------------------------------------------------------- 最小 ZIP 写入器

export interface ZipSpecEntry {
  name: string;
  data: Buffer;
  /** 原始文件名字节；给了就不置 UTF-8 标志位（模拟旧编码 zip） */
  nameBytes?: Buffer;
  /** 置通用位标志 bit0（加密位）；内容仍是明文——node-stream-zip 只看标志位 */
  encrypted?: boolean;
  /** 压缩方法："store"（默认）| "deflate"（真压缩，用于验证自研 inflate 回退路径） */
  method?: "store" | "deflate";
}

/**
 * 最小 ZIP 写入器（store 方法，不压缩）。存在的唯一理由：制造"缺少 UTF-8 标志位的
 * 非 UTF-8 文件名"这种真实世界很常见、但 7za 造不出来的样本，用于验证编码探测。
 */
export function buildZip(entries: ZipSpecEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = e.nameBytes ?? Buffer.from(e.name, "utf8");
    const isUtf8 = e.nameBytes === undefined;
    const flags = (isUtf8 ? 0x0800 : 0) | (e.encrypted ? 0x0001 : 0);
    const method = e.method === "deflate" ? 8 : 0;
    const payload = method === 8 ? deflateRawSync(e.data) : e.data;
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12); // date 1980-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBytes.length, 26);
    lh.writeUInt16LE(0, 28);
    const local = Buffer.concat([lh, nameBytes, payload]);
    locals.push(local);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBytes.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nameBytes]));
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

// ---------------------------------------------------------------- 最小 TAR.GZ 写入器

export interface TarSpecEntry { name: string; data?: Buffer; type?: "0" | "5" }

function tarHeader(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100, 8, "binary");
  h.write("0000000\0", 108, 8, "binary");
  h.write("0000000\0", 116, 8, "binary");
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "binary");
  h.write("00000000000\0", 136, 12, "binary");
  h.write("        ", 148, 8, "binary"); // 校验和先填空格
  h.write(type, 156, 1, "binary");
  h.write("ustar\0" + "00", 257, 8, "binary");
  h.write("root\0", 265, 5, "binary");
  h.write("root\0", 297, 5, "binary");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "binary");
  return h;
}

/** 最小 tar.gz 写入器（用于合成 unitypackage：顺序、目录条目、缺 pathname 等边界）。 */
export function buildTarGz(entries: TarSpecEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    parts.push(tarHeader(e.name, data.length, e.type ?? "0"));
    if (data.length > 0) {
      parts.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 6 });
}

/** 1x1 与可读的 PNG（不依赖 sharp，供 unitypackage preview 用例用已知字节）。 */
export const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** "テスト.txt" 的 Shift-JIS 字节（用于验证旧编码 zip 文件名探测）。 */
export const SHIFT_JIS_TEST_NAME = Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x2e, 0x74, 0x78, 0x74]);
