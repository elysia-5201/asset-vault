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
 */
import { createReadStream } from "node:fs";
import { statSync } from "node:fs";
import { createGunzip, type Gunzip } from "node:zlib";
import { AppError, type UnityPackageAsset, type UnityPackageListing } from "./contracts";

/** 默认最多解析的 GUID 数；超出 → truncated=true 并提前停止。 */
export const DEFAULT_MAX_ASSETS = 10000;
/** preview.png 读取上限（防止畸形包把 preview 写成 GB 级）。 */
export const DEFAULT_MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
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

type EntryDecision = { mode: "buffer" } | { mode: "skip" };
async function driveTar(
  cursor: ByteCursor,
  maxEntries: number,
  decide: (name: string, size: number, type: string) => EntryDecision,
  onEntry: (name: string, size: number, type: string, data: Buffer | null) => void,
): Promise<{ entries: number; stopped: boolean }> {
  let entries = 0;
  let pendingLongName: string | null = null;
  while (true) {
    if (entries >= maxEntries) return { entries, stopped: true };
    const block = await cursor.readExact(TAR_BLOCK);
    if (!block) return { entries, stopped: false };
    const hdr = parseTarHeader(block);
    if (!hdr) return { entries, stopped: false };
    const padded = Math.ceil(hdr.size / TAR_BLOCK) * TAR_BLOCK;
    if (hdr.type === "L") {
      const d = await cursor.readExact(hdr.size);
      if (!d) return { entries, stopped: false };
      pendingLongName = cstr(d, 0, d.length);
      if (!(await cursor.skip(padded - hdr.size))) return { entries, stopped: false };
      continue;
    }
    if (hdr.type === "x" || hdr.type === "g" || hdr.type === "K") {
      if (!(await cursor.skip(padded))) return { entries, stopped: false };
      continue;
    }
    const name = (pendingLongName ?? hdr.name).replace(/^\.\//, "");
    pendingLongName = null;
    entries++;
    const decision = decide(name, hdr.size, hdr.type);
    if (decision.mode === "buffer") {
      const data = await cursor.readExact(hdr.size);
      if (!data) return { entries, stopped: false };
      onEntry(name, hdr.size, hdr.type, Buffer.from(data));
      if (!(await cursor.skip(padded - hdr.size))) return { entries, stopped: false };
    } else {
      onEntry(name, hdr.size, hdr.type, null);
      if (!(await cursor.skip(padded))) return { entries, stopped: false };
    }
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

export interface UnityPackageParseResult extends UnityPackageListing { tarEntries: number; guidCount: number }

/**
 * parseUnityPackage：扩展结果（比冻结接口多两个计数，供测试/诊断用度量）。
 * 与 listUnityPackage 共用同一条解析路径，不存在"两套实现互相印证"的退化度量。
 */
export async function parseUnityPackage(file: string, opts?: { maxAssets?: number }): Promise<UnityPackageParseResult> {
  const maxAssets = Math.max(1, Math.floor(opts?.maxAssets ?? DEFAULT_MAX_ASSETS));
  const opened = openUnityPackage(file);
  const byGuid = new Map<string, { assetPath: string | null; isDir: boolean; size: number | null; hasPreview: boolean; type: string | null; tarAssetSize: number | null }>();
  const guidOrder: string[] = [];
  const previewGuids = new Set<string>();
  let guidsSeen = 0;
  let truncated = false;
  let tarEntries = 0;
  try {
    const res = await driveTar(
      opened.cursor,
      Number.MAX_SAFE_INTEGER,
      (name) => {
        const slash = name.indexOf("/");
        if (slash <= 0) return { mode: "skip" };
        const guid = name.slice(0, slash);
        const leaf = name.slice(slash + 1);
        // 只物化 pathname（小），其余一律 skip
        if (leaf === "pathname" || leaf === "preview.png") {
          if (leaf === "preview.png") {
            // preview 可能早于 asset 条目出现，先记在 Set 里，最后合并
            previewGuids.add(guid);
            return { mode: "skip" };
          }
          return { mode: "buffer" };
        }
        if (leaf === "asset") {
          if (!byGuid.has(guid) && guidsSeen >= maxAssets) { truncated = true; }
          return { mode: "skip" };
        }
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
        }
      },
    );
    tarEntries = res.entries;
    if (res.stopped) truncated = true;
  } catch (err) {
    throw translateStreamError(err, file);
  } finally {
    opened.cleanup();
  }
  const assets: UnityPackageAsset[] = [];
  for (const guid of guidOrder) {
    const rec = byGuid.get(guid);
    if (!rec || !rec.assetPath) continue; // 没有 pathname 的 guid 不是资产条目
    assets.push({ guid, assetPath: rec.assetPath, type: rec.type, size: rec.size, hasPreview: rec.hasPreview || previewGuids.has(guid) });
  }
  return { assets, truncated, tarEntries, guidCount: byGuid.size };
}

/** listUnityPackage：冻结接口（CONTRACT §4）。 */
export async function listUnityPackage(file: string, opts?: { maxAssets?: number }): Promise<UnityPackageListing> {
  const { assets, truncated } = await parseUnityPackage(file, opts);
  return { assets, truncated };
}

/**
 * readUnityPackagePreview：流式找 <guid>/preview.png 并返回其字节；不存在返回 null。
 * 只读该条目（其他一律 skip），最大 DEFAULT_MAX_PREVIEW_BYTES。
 */
export async function readUnityPackagePreview(file: string, guid: string): Promise<Buffer | null> {
  if (typeof guid !== "string" || !/^[0-9a-fA-F]{16,64}$/.test(guid)) {
    throw new AppError("INVALID_INPUT", `readUnityPackagePreview: bad guid "${guid}"`, 400);
  }
  // 上限固定为 DEFAULT_MAX_PREVIEW_BYTES：签名与 CONTRACT §4 完全一致（不额外加参数）
  const cap = DEFAULT_MAX_PREVIEW_BYTES;
  const opened = openUnityPackage(file);
  const wanted = `${guid}/preview.png`;
  let found: Buffer | null = null;
  try {
    await driveTar(
      opened.cursor,
      Number.MAX_SAFE_INTEGER,
      (name, size) => (name === wanted && size <= cap ? { mode: "buffer" } : { mode: "skip" }),
      (name, _size, _type, data) => { if (name === wanted && data) { found = data; } },
    );
  } catch (err) {
    throw translateStreamError(err, file);
  } finally {
    opened.cleanup();
  }
  return found;
}

/**
 * readUnityPackageAsset：流式找 <guid>/asset（包内文件本体）并返回其字节；不存在返回 null。
 * 只读该条目，其他一律 skip —— 用来预览「包里的某个文件」（ReadMe.txt / .mat / .asset …）。
 */
export async function readUnityPackageAsset(file: string, guid: string, maxBytes = 64 * 1024 * 1024): Promise<Buffer | null> {
  if (typeof guid !== "string" || !/^[0-9a-fA-F]{16,64}$/.test(guid)) {
    throw new AppError("INVALID_INPUT", "readUnityPackageAsset: bad guid " + guid, 400);
  }
  const cap = Math.max(1024, Math.min(maxBytes, 512 * 1024 * 1024));
  const opened = openUnityPackage(file);
  const wanted = guid + "/asset";
  let found: Buffer | null = null;
  try {
    await driveTar(
      opened.cursor,
      Number.MAX_SAFE_INTEGER,
      (name, size) => (name === wanted && size <= cap ? { mode: "buffer" } : { mode: "skip" }),
      (name, _size, _type, data) => { if (name === wanted && data) { found = data; } },
    );
  } catch (err) {
    throw translateStreamError(err, file);
  } finally {
    opened.cleanup();
  }
  return found;
}

/** 低层导出（测试/诊断）：只数 tar 条目与 GUID，不建结果集。 */
export async function countUnityPackageTarEntries(file: string): Promise<{ tarEntries: number; guidCount: number }> {
  const r = await parseUnityPackage(file);
  return { tarEntries: r.tarEntries, guidCount: r.guidCount };
}
