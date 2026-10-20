/**
 * .unitypackage 解析（core-content 所有）—— gzip + tar，纯流式，不启动 Unity。
 *
 * 包格式（CONTRACT §5 已核实）：tar 条目形如 `<guid>/asset`、`<guid>/asset.meta`、
 * `<guid>/pathname`、`<guid>/preview.png`。因此：
 *   assetPath ← <guid>/pathname 的内容
 *   type      ← assetPath 扩展名推导（Unity 资产类型名）
 *   size      ← <guid>/asset 条目的 tar size（目录型条目为 null）
 *   hasPreview← 是否存在 <guid>/preview.png
 *
 * 内存纪律：91 MB 的 MANUKA.unitypackage 只解压路径/元数据条目；asset/preview 数据一律 skip，
 * 靠 512 字节对齐跳过，不整块进内存（单次解析常量内存 ~1 MiB 读块 + pathname 小缓冲）。
 *
 * v0.6.0（lead 冻结契约，向后兼容）：
 *   - listUnityPackage 新增 opts: maxAssets / maxEntryBytes / maxTotalBytes / timeoutMs / signal
 *     超限 **不抛**：返回 limited:{code,message} + bytesRead，并**提前停止扫描**（不再读完整个包）。
 *     —— 旧实现即使 maxAssets=1 也要把 91MB 读完（实测 718ms vs 702ms，审计结论），这一版是真早停。
 *   - readUnityPackagePreview 新增第 3 参 opts: { maxBytes?, signal?, timeoutMs? }
 *   - UNITYPACKAGE_PARSER_VERSION=2：语义/限制变化 +1（流水线缓存键带版本）
 */
import { createReadStream } from "node:fs";
import { statSync } from "node:fs";
import { createGunzip, type Gunzip } from "node:zlib";
import { AppError, type UnityPackageAsset, type UnityPackageListing } from "./contracts";
import { deadlineOf, isCancelledError, isTimeoutError, type AbortOptions, type Deadline } from "./abort";
import { LimitError, normalizeLimit, type ListingLimit } from "./limits";

/** 默认最多解析的 GUID 数；超出 → truncated=true 并提前停止。 */
export const DEFAULT_MAX_ASSETS = 10000;
/** preview.png 读取上限（防止畸形包把 preview 写成 GB 级）。 */
export const DEFAULT_MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
/** 解析器语义版本（流水线缓存键用）。 */
export const UNITYPACKAGE_PARSER_VERSION = 2;
const READ_CHUNK = 1 << 20;
const TAR_BLOCK = 512;

// ---------------------------------------------------------------- tar 低层

interface TarHeader { name: string; size: number; type: string }

/** 拉取式字节游标：在 AsyncIterable<Buffer> 上提供 readExact/skip，零拷贝视图。 */
class ByteCursor {
  private it: AsyncIterator<Buffer>;
  private buf: Buffer = Buffer.alloc(0);
  private pos = 0;
  private streamEnded = false;
  constructor(src: AsyncIterable<Buffer>) { this.it = src[Symbol.asyncIterator](); }

  private async pull(): Promise<boolean> {
    while (!this.streamEnded) {
      const r = await this.it.next();
      if (r.done) { this.streamEnded = true; return false; }
      const raw = r.value as Buffer;
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as unknown as Uint8Array);
      if (chunk.length === 0) continue;
      if (this.pos > 0) { this.buf = this.buf.subarray(this.pos); this.pos = 0; }
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      return true;
    }
    return false;
  }

  /** 精确读 n 字节；EOF 不足则返回 null。返回的是内部缓冲视图，调用方需保留请自行 copy。 */
  async readExact(n: number): Promise<Buffer | null> {
    while (this.buf.length - this.pos < n) {
      if (!(await this.pull())) return null;
    }
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** 跳过 n 字节（不物化）。EOF 不足返回 false。 */
  async skip(n: number): Promise<boolean> {
    let remaining = n;
    while (remaining > 0) {
      const avail = this.buf.length - this.pos;
      if (avail === 0) { if (!(await this.pull())) return false; continue; }
      const take = Math.min(avail, remaining);
      this.pos += take;
      remaining -= take;
    }
    return true;
  }
}

function cstr(buf: Buffer, start: number, len: number): string {
  const end = buf.indexOf(0, start);
  const stop = end === -1 || end > start + len ? start + len : end;
  return buf.toString("utf8", start, stop);
}

function parseOctal(buf: Buffer, start: number, len: number): number {
  // GNU base-256（大文件）编码：首字节 0x80
  if (buf[start] & 0x80) {
    let v = 0;
    for (let i = start + 1; i < start + len; i++) v = v * 256 + buf[i];
    return v;
  }
  const s = cstr(buf, start, len).trim();
  if (s === "") return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

function parseTarHeader(block: Buffer): TarHeader | null {
  let allZero = true;
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) { allZero = false; break; }
  if (allZero) return null;
  const name = cstr(block, 0, 100);
  const prefix = cstr(block, 345, 155);
  const size = parseOctal(block, 124, 12);
  const typeByte = block[156];
  const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
  return { name: prefix ? `${prefix}/${name}` : name, size, type };
}

type EntryDecision = { mode: "buffer" } | { mode: "skip" } | { mode: "stop" };

interface DriveOptions {
  deadline?: Deadline | null;
  /** 最多消费多少条 tar 条目（null = 不限制） */
  maxEntries?: number | null;
  /** 最多消费多少解压后字节（null = 不限制） */
  maxTotalBytes?: number | null;
}

interface DriveResult { entries: number; bytesRead: number; stopped: boolean; limited: ListingLimit | null }

/**
 * 驱动 tar 解析。
 * 检查点：每读一个 tar 头之前 → deadline.check()；命中上限直接停（不读完整个包）。
 * bytesRead 统计的是**解压后**被消费的字节（头块 + 数据块，含 padding）。
 */
async function driveTar(
  cursor: ByteCursor,
  decide: (name: string, size: number, type: string) => EntryDecision,
  onEntry: (name: string, size: number, type: string, data: Buffer | null) => void,
  opts: DriveOptions = {},
): Promise<DriveResult> {
  const deadline = opts.deadline ?? null;
  const maxEntries = opts.maxEntries ?? null;
  const maxTotalBytes = opts.maxTotalBytes ?? null;
  let entries = 0;
  let bytesRead = 0;
  let limited: ListingLimit | null = null;
  let pendingLongName: string | null = null;
  while (true) {
    deadline?.check();
    if (maxEntries !== null && entries >= maxEntries) {
      limited = { code: "ENTRIES", message: `stopped at maxEntries=${maxEntries}` };
      return { entries, bytesRead, stopped: true, limited };
    }
    const block = await cursor.readExact(TAR_BLOCK);
    if (!block) return { entries, bytesRead, stopped: false, limited };
    bytesRead += TAR_BLOCK;
    const hdr = parseTarHeader(block);
    if (!hdr) return { entries, bytesRead, stopped: false, limited };
    const padded = Math.ceil(hdr.size / TAR_BLOCK) * TAR_BLOCK;
    if (maxTotalBytes !== null && bytesRead + padded > maxTotalBytes) {
      limited = { code: "BYTES", message: `bytesRead ${bytesRead} + entry ${padded} > maxTotalBytes ${maxTotalBytes}` };
      return { entries, bytesRead, stopped: true, limited };
    }
    if (hdr.type === "L") {
      const d = await cursor.readExact(hdr.size);
      if (!d) return { entries, bytesRead, stopped: false, limited };
      pendingLongName = cstr(d, 0, d.length);
      if (!(await cursor.skip(padded - hdr.size))) return { entries, bytesRead, stopped: false, limited };
      bytesRead += padded;
      continue;
    }
    if (hdr.type === "x" || hdr.type === "g" || hdr.type === "K") {
      if (!(await cursor.skip(padded))) return { entries, bytesRead, stopped: false, limited };
      bytesRead += padded;
      continue;
    }
    const name = (pendingLongName ?? hdr.name).replace(/^\.\//, "");
    pendingLongName = null;
    entries++;
    const decision = decide(name, hdr.size, hdr.type);
    if (decision.mode === "stop") {
      return { entries: entries - 1, bytesRead, stopped: true, limited };
    }
    if (decision.mode === "buffer") {
      const data = await cursor.readExact(hdr.size);
      if (!data) return { entries, bytesRead, stopped: false, limited };
      onEntry(name, hdr.size, hdr.type, Buffer.from(data));
      if (!(await cursor.skip(padded - hdr.size))) return { entries, bytesRead, stopped: false, limited };
    } else {
      onEntry(name, hdr.size, hdr.type, null);
      if (!(await cursor.skip(padded))) return { entries, bytesRead, stopped: false, limited };
    }
    bytesRead += padded;
  }
}

// ---------------------------------------------------------------- 打开流

interface OpenedStream { src: ReturnType<typeof createReadStream>; gunzip: Gunzip; cursor: ByteCursor; cleanup: () => void }

function openUnityPackage(file: string): OpenedStream {
  let st;
  try { st = statSync(file); } catch { throw new AppError("NOT_FOUND", `unitypackage not found: ${file}`, 404); }
  if (!st.isFile()) throw new AppError("NOT_AN_ARCHIVE", `not a regular file: ${file}`, 400);
  const src = createReadStream(file, { highWaterMark: READ_CHUNK });
  const gunzip = createGunzip();
  // 手动 pipe + 双向错误传播：源文件 ENOENT / gzip 头损坏都会让 gunzip 的 async 迭代抛错
  src.on("error", (err) => gunzip.destroy(err));
  gunzip.on("error", () => { /* 由迭代方捕获；避免 unhandled 'error' */ });
  src.pipe(gunzip);
  const cursor = new ByteCursor(gunzip as unknown as AsyncIterable<Buffer>);
  return { src, gunzip, cursor, cleanup: () => { try { src.destroy(); } catch { /* */ } try { gunzip.destroy(); } catch { /* */ } } };
}

function translateStreamError(err: unknown, file: string): AppError {
  if (err instanceof AppError) return err;
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "ENOENT") return new AppError("NOT_FOUND", `unitypackage not found: ${file}`, 404);
  return new AppError("NOT_AN_ARCHIVE", `not a valid gzip/tar unitypackage (${file}): ${e?.message ?? String(err)}`, 400);
}

// ---------------------------------------------------------------- 类型推导

const EXT_TYPE: Record<string, string> = {
  ".prefab": "Prefab", ".fbx": "Model", ".obj": "Model", ".blend": "Model", ".dae": "Model", ".3ds": "Model", ".max": "Model",
  ".png": "Texture2D", ".jpg": "Texture2D", ".jpeg": "Texture2D", ".tga": "Texture2D", ".psd": "Texture2D", ".tif": "Texture2D",
  ".tiff": "Texture2D", ".bmp": "Texture2D", ".exr": "Texture2D", ".hdr": "Texture2D", ".gif": "Texture2D", ".webp": "Texture2D",
  ".mat": "Material", ".anim": "AnimationClip", ".controller": "AnimatorController", ".overrideController": "AnimatorOverrideController",
  ".shader": "Shader", ".shadergraph": "Shader", ".cs": "MonoScript", ".asmdef": "AssemblyDefinitionAsset",
  ".unity": "Scene", ".asset": "Asset", ".preset": "Preset", ".mask": "AvatarMask", ".playable": "Playable",
  ".wav": "AudioClip", ".mp3": "AudioClip", ".ogg": "AudioClip", ".aif": "AudioClip", ".aiff": "AudioClip", ".flac": "AudioClip",
  ".ttf": "Font", ".otf": "Font", ".ttc": "Font", ".physicMaterial": "PhysicsMaterial", ".physicsMaterial2D": "PhysicsMaterial2D",
  ".cubemap": "Cubemap", ".renderTexture": "RenderTexture", ".guiskin": "GUISkin", ".fontsettings": "Font",
};

/** 由 assetPath 扩展名推导 Unity 资产类型名；未知扩展名返回 null。 */
export function unityTypeFromPath(assetPath: string): string | null {
  const base = assetPath.slice(assetPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot).toLowerCase();
  return EXT_TYPE[ext] ?? null;
}

function parsePathnameContent(buf: Buffer): string | null {
  let text = buf.toString("utf8").replace(/^\uFEFF/, "").trim();
  if (text.startsWith("{")) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const v = j["pathname"] ?? j["path"] ?? j["assetPath"];
      if (typeof v === "string") text = v;
    } catch { /* 不是 JSON，按纯文本处理 */ }
  }
  const first = text.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
  return first && first.length > 0 ? first : null;
}

// ---------------------------------------------------------------- 公共 API

export interface ListUnityPackageOptions extends AbortOptions {
  /** 最多解析多少 GUID（默认 10000）；超出 → truncated + limited.code=ENTRIES，并提前停止扫描 */
  maxAssets?: number;
  /** 单个 <guid>/asset 声明字节超过它 → 只标记 limited.code=BYTES（资产仍然列出） */
  maxEntryBytes?: number;
  /** 解压后消费字节上限 → 提前停止 + limited.code=BYTES（超大批量扫描时的总预算） */
  maxTotalBytes?: number;
}

export interface UnityPackageListingResult extends UnityPackageListing {
  /** 命中的第一个上限（null = 完整扫描） */
  limited: ListingLimit | null;
  /** 解压后实际消费的字节数（提前停止时会明显小于包体） */
  bytesRead: number;
}

export interface UnityPackageParseResult extends UnityPackageListingResult { tarEntries: number; guidCount: number }

/**
 * parseUnityPackage：扩展结果（比冻结接口多两个计数，供测试/诊断用度量）。
 * 与 listUnityPackage 共用同一条解析路径，不存在"两套实现互相印证"的退化度量。
 */
export async function parseUnityPackage(file: string, opts: ListUnityPackageOptions = {}): Promise<UnityPackageParseResult> {
  const maxAssets = Math.max(1, Math.floor(opts.maxAssets ?? DEFAULT_MAX_ASSETS));
  const maxEntryBytes = normalizeLimit("maxEntryBytes", opts.maxEntryBytes, 1);
  const maxTotalBytes = normalizeLimit("maxTotalBytes", opts.maxTotalBytes, 1);
  const deadline = deadlineOf(opts, `listUnityPackage ${file}`);
  /** 列表入口的取消/超时降级：返回 limited 而不是抛（契约：列表可降级，读 Buffer 不可）。 */
  const limitFromStop = (err: unknown): ListingLimit | null => {
    if (isCancelledError(err)) return { code: "CANCELLED", message: (err as Error).message };
    if (isTimeoutError(err)) return { code: "TIMEOUT", message: (err as Error).message };
    return null;
  };
  const opened = openUnityPackage(file);
  const byGuid = new Map<string, { assetPath: string | null; isDir: boolean; size: number | null; hasPreview: boolean; type: string | null; tarAssetSize: number | null }>();
  const guidOrder: string[] = [];
  let guidsSeen = 0;
  let truncated = false;
  let tarEntries = 0;
  let bytesRead = 0;
  let limited: ListingLimit | null = null;
  try {
    const res = await driveTar(
      opened.cursor,
      (name, size) => {
        const slash = name.indexOf("/");
        if (slash <= 0) return { mode: "skip" };
        const guid = name.slice(0, slash);
        const leaf = name.slice(slash + 1);
        // 早停：新 GUID 且已到上限 —— 不再往下读完整个包
        if (!byGuid.has(guid) && guidsSeen >= maxAssets) {
          truncated = true;
          if (!limited) limited = { code: "ENTRIES", message: `stopped at maxAssets=${maxAssets}` };
          return { mode: "stop" };
        }
        if (maxEntryBytes !== null && leaf === "asset" && size > maxEntryBytes && !limited) {
          limited = { code: "BYTES", message: `entry ${name.slice(0, 80)} declared ${size} > maxEntryBytes ${maxEntryBytes}` };
        }
        // 只物化 pathname（小），其余一律 skip
        if (leaf === "pathname") return { mode: "buffer" };
        if (leaf === "preview.png") return { mode: "skip" };
        return { mode: "skip" };
      },
      (name, size, type, data) => {
        const slash = name.indexOf("/");
        if (slash <= 0) return;
        const guid = name.slice(0, slash);
        const leaf = name.slice(slash + 1);
        if (/^[0-9a-fA-F]{32}$/.test(guid) === false && !/^[0-9a-fA-F-]{16,64}$/.test(guid)) return;
        let rec = byGuid.get(guid);
        if (!rec) {
          if (guidsSeen >= maxAssets) { truncated = true; return; }
          rec = { assetPath: null, isDir: false, size: null, hasPreview: false, type: null, tarAssetSize: null };
          byGuid.set(guid, rec);
          guidOrder.push(guid);
          guidsSeen++;
        }
        if (leaf === "asset") {
          if (type === "5") rec.isDir = true;
          rec.tarAssetSize = size;
          rec.size = type === "5" ? null : size;
        } else if (leaf === "pathname" && data) {
          const p = parsePathnameContent(data);
          if (p) { rec.assetPath = p; rec.type = rec.isDir ? null : unityTypeFromPath(p); }
        } else if (leaf === "preview.png") {
          rec.hasPreview = true;
        }
      },
      { deadline, maxEntries: null, maxTotalBytes },
    );
    tarEntries = res.entries;
    bytesRead = res.bytesRead;
    if (res.stopped) truncated = true;
    if (res.limited && !limited) limited = res.limited;
  } catch (err) {
    // 取消/超时 → 降级成部分结果（流水线据此标 limited，而不是把整条任务判失败）
    const limit = limitFromStop(err);
    if (limit) { limited = limit; truncated = true; }
    else throw translateStreamError(err, file);
  } finally {
    opened.cleanup();
    deadline?.dispose();
  }
  const assets: UnityPackageAsset[] = [];
  for (const guid of guidOrder) {
    const rec = byGuid.get(guid);
    if (!rec || !rec.assetPath) continue; // 没有 pathname 的 guid 不是资产条目
    assets.push({ guid, assetPath: rec.assetPath, type: rec.type, size: rec.size, hasPreview: rec.hasPreview });
  }
  return { assets, truncated, limited, bytesRead, tarEntries, guidCount: byGuid.size };
}

/** listUnityPackage：冻结接口（CONTRACT §4）+ v0.6.0 限制字段。 */
export async function listUnityPackage(file: string, opts: ListUnityPackageOptions = {}): Promise<UnityPackageListingResult> {
  const { assets, truncated, limited, bytesRead } = await parseUnityPackage(file, opts);
  return { assets, truncated, limited, bytesRead };
}

export interface PreviewOptions extends AbortOptions {
  /** preview.png 字节上限（默认 16 MiB）；超过 → LimitError(code="BYTES") */
  maxBytes?: number;
}

/**
 * readUnityPackagePreview：流式找 <guid>/preview.png 并返回其字节；不存在返回 null。
 * 只读该条目（其他一律 skip），默认最大 DEFAULT_MAX_PREVIEW_BYTES。
 * v0.6.0：第 3 参支持 { maxBytes, signal, timeoutMs }；超限抛 LimitError，取消抛 CANCELLED。
 */
export async function readUnityPackagePreview(file: string, guid: string, opts: PreviewOptions = {}): Promise<Buffer | null> {
  if (typeof guid !== "string" || !/^[0-9a-fA-F]{16,64}$/.test(guid)) {
    throw new AppError("INVALID_INPUT", `readUnityPackagePreview: bad guid "${guid}"`, 400);
  }
  const cap = Math.floor(opts.maxBytes ?? DEFAULT_MAX_PREVIEW_BYTES);
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new AppError("INVALID_INPUT", `readUnityPackagePreview: maxBytes must be positive (got ${opts.maxBytes})`, 400);
  }
  const deadline = deadlineOf(opts, `readUnityPackagePreview ${file}:${guid}`);
  const opened = openUnityPackage(file);
  const wanted = `${guid}/preview.png`;
  let found: Buffer | null = null;
  let tooLarge = false;
  try {
    await driveTar(
      opened.cursor,
      (name, size) => {
        if (name !== wanted) return { mode: "skip" };
        if (size > cap) { tooLarge = true; return { mode: "stop" }; }
        return { mode: "buffer" };
      },
      (name, _size, _type, data) => { if (name === wanted && data) { found = data; } },
      { deadline },
    );
  } catch (err) {
    throw translateStreamError(err, file);
  } finally {
    opened.cleanup();
    deadline?.dispose();
  }
  if (tooLarge) throw new LimitError("BYTES", `preview too large for guid ${guid}: > maxBytes ${cap}`);
  return found;
}

/**
 * readUnityPackageAsset：流式找 <guid>/asset（包内文件本体）并返回其字节；不存在返回 null。
 * 只读该条目，其他一律 skip —— 用来预览「包里的某个文件」（ReadMe.txt / .mat / .asset …）。
 */
export async function readUnityPackageAsset(file: string, guid: string, maxBytes = 64 * 1024 * 1024, opts: AbortOptions = {}): Promise<Buffer | null> {
  if (typeof guid !== "string" || !/^[0-9a-fA-F]{16,64}$/.test(guid)) {
    throw new AppError("INVALID_INPUT", "readUnityPackageAsset: bad guid " + guid, 400);
  }
  const cap = Math.max(1024, Math.min(maxBytes, 512 * 1024 * 1024));
  const deadline = deadlineOf(opts, `readUnityPackageAsset ${file}:${guid}`);
  const opened = openUnityPackage(file);
  const wanted = guid + "/asset";
  let found: Buffer | null = null;
  try {
    await driveTar(
      opened.cursor,
      (name, size) => (name === wanted && size <= cap ? { mode: "buffer" } : { mode: "skip" }),
      (name, _size, _type, data) => { if (name === wanted && data) { found = data; } },
      { deadline },
    );
  } catch (err) {
    throw translateStreamError(err, file);
  } finally {
    opened.cleanup();
    deadline?.dispose();
  }
  return found;
}

/** 低层导出（测试/诊断）：只数 tar 条目与 GUID，不建结果集。 */
export async function countUnityPackageTarEntries(file: string): Promise<{ tarEntries: number; guidCount: number }> {
  const r = await parseUnityPackage(file);
  return { tarEntries: r.tarEntries, guidCount: r.guidCount };
}
