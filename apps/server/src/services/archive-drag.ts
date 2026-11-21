import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { AssetRow } from "../../../../packages/core/src/contracts";
import { readArchiveEntry, safeEntryPath } from "../../../../packages/core/src/archive/list";

const ARCHIVES = new Set(["zip", "7z", "rar"]);
const MIB = 1024 * 1024;
const MAX_ENTRY_BYTES = 128 * MIB;
const MAX_CACHE_BYTES = 512 * MIB;
const MAX_FILES = 24;
const MAX_PENDING = 4;
const TTL_MS = 15 * 60_000;
const LEASE_MS = 2 * 60_000;

type AssetRef = Pick<AssetRow, "path" | "status" | "container">;
type DragRef = { assetId: number; entryPath: string; nested?: string };
type Source = { path: string; signature: string };
type Cached = {
  token: string; dir: string; file: string; bytes: number; assetId: number;
  source: Source; touched: number; leasedUntil: number;
};

function normalizeEntry(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || /[\\/]$/.test(value)) throw new Error("文件路径无效，无法拖动");
  const p = safeEntryPath(value);
  if (!p.ok) throw new Error("文件路径无效，无法拖动");
  return p.path;
}

function parseRef(value: unknown): DragRef {
  if (!value || typeof value !== "object") throw new Error("拖动信息无效");
  const { assetId, entryPath, nested } = value as Record<string, unknown>;
  if (typeof assetId !== "number" || !Number.isSafeInteger(assetId) || assetId <= 0) throw new Error("拖动信息无效");
  return { assetId, entryPath: normalizeEntry(entryPath), nested: nested === undefined ? undefined : normalizeEntry(nested) };
}

function safeLeaf(path: string): string {
  const name = path.split("/").at(-1)!;
  if (!name || name.length > 255 || /[<>:"/\\|?*\u0000-\u001F]/.test(name)
    || /[. ]$/.test(name) || /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?: *\.|$)/iu.test(name)) {
    throw new Error("文件名不适用于 Windows，无法拖动");
  }
  return name;
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function sameSource(a: Source, b: Source): boolean { return a.path === b.path && a.signature === b.signature; }

async function extract(path: string, entry: string): Promise<Buffer> {
  try { return await readArchiveEntry(path, entry, MAX_ENTRY_BYTES, { timeoutMs: 30_000 }); }
  catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "BYTES") throw new Error("文件或内部压缩包超过 128 MiB，无法拖出");
    if (code === "TIMEOUT") throw new Error("解压超时，请重试");
    if (code === "ARCHIVE_PASSWORD") throw new Error("压缩包已加密，无法拖出");
    if (code === "NOT_FOUND") throw new Error("包内文件已不存在，请刷新目录后重试");
    throw new Error("无法读取包内文件，请检查压缩包");
  }
}

export function createArchiveDragStaging(getAsset: (id: number) => AssetRef | null, options: { tempDir?: string } = {}) {
  let root: string | undefined;
  let stopped = false;
  let queue = Promise.resolve();
  const pending = new Map<string, Promise<string>>();
  const files = new Map<string, Cached>();

  function currentSource(assetId: number): Source {
    const asset = getAsset(assetId);
    if (asset?.status !== "present") throw new Error("源文件不存在或已离线");
    if (!ARCHIVES.has(asset.container)) throw new Error("仅支持 ZIP、7z 或 RAR 压缩包中的文件");
    const st = statSync(asset.path, { throwIfNoEntry: false });
    if (!st?.isFile()) throw new Error("源压缩包当前不可访问");
    return { path: asset.path, signature: [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(":") };
  }

  async function discard(key: string, file: Cached) {
    files.delete(key);
    await rm(file.dir, { recursive: true, force: true }).catch(() => {});
  }

  async function makeRoom(bytes: number) {
    const now = Date.now();
    for (const [key, file] of files) {
      if (file.leasedUntil <= now && now - file.touched >= TTL_MS) await discard(key, file);
    }
    let used = [...files.values()].reduce((sum, file) => sum + file.bytes, 0);
    for (const [key, file] of [...files].sort((a, b) => a[1].touched - b[1].touched)) {
      if (used + bytes <= MAX_CACHE_BYTES && files.size < MAX_FILES) break;
      if (file.leasedUntil > Date.now()) continue;
      await discard(key, file);
      used -= file.bytes;
    }
    if (used + bytes > MAX_CACHE_BYTES || files.size >= MAX_FILES) throw new Error("临时文件正被使用，请稍后再拖");
  }

  async function stage(ref: DragRef, source: Source, key: string, leaf: string) {
    if (stopped) throw new Error("文件拖动已关闭");
    if (!sameSource(source, currentSource(ref.assetId))) throw new Error("源压缩包已更改，请重试");
    root ??= await mkdtemp(join(options.tempDir ?? tmpdir(), "asset-vault-drag-"));
    const dir = await mkdtemp(join(root, "file-"));
    try {
      let input = source.path;
      if (ref.nested) {
        const ext = extname(ref.nested).slice(1).toLowerCase();
        if (!ARCHIVES.has(ext)) throw new Error("仅支持 ZIP、7z 或 RAR 内部压缩包");
        input = join(dir, ".nested-" + randomBytes(8).toString("hex") + "." + ext);
        await writeFile(input, await extract(source.path, ref.nested), { flag: "wx" });
      }
      const data = await extract(input, ref.entryPath);
      if (ref.nested) await rm(input);
      await makeRoom(data.byteLength);
      const file = join(dir, leaf);
      await writeFile(file, data, { flag: "wx" });
      if (!sameSource(source, currentSource(ref.assetId))) throw new Error("源压缩包已更改，请重试");
      const token = randomBytes(24).toString("base64url");
      files.set(key, { token, dir, file, bytes: data.byteLength, assetId: ref.assetId, source, touched: Date.now(), leasedUntil: 0 });
      return token;
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      if (error instanceof Error && "code" in error) throw new Error("无法写入临时拖动文件，请检查临时目录与磁盘空间");
      throw error;
    }
  }

  return {
    async prepare(value: unknown): Promise<string> {
      if (stopped) throw new Error("文件拖动已关闭");
      const ref = parseRef(value);
      const leaf = safeLeaf(ref.entryPath);
      const source = currentSource(ref.assetId);
      const key = JSON.stringify([ref.assetId, source.path, source.signature, ref.nested ?? "", ref.entryPath]);
      const file = files.get(key);
      if (file && Date.now() - file.touched < TTL_MS && isFile(file.file)) {
        file.touched = Date.now();
        return file.token;
      }
      const existing = pending.get(key);
      if (existing) return existing;
      if (pending.size >= MAX_PENDING) throw new Error("其他文件正在解压，请稍后再拖");
      const task = queue.then(async () => {
        if (file) await discard(key, file);
        return stage(ref, source, key, leaf);
      }).finally(() => { pending.delete(key); });
      queue = task.then(() => {}, () => {});
      pending.set(key, task);
      return task;
    },
    fileForToken(token: unknown): string | null {
      if (stopped || typeof token !== "string" || !/^[\w-]{32}$/.test(token)) return null;
      const file = [...files.values()].find((f) => f.token === token);
      const now = Date.now();
      if (!file || now - file.touched >= TTL_MS || !isFile(file.file)) return null;
      try { if (!sameSource(file.source, currentSource(file.assetId))) return null; }
      catch { return null; }
      file.touched = now;
      file.leasedUntil = now + LEASE_MS;
      return file.file;
    },
    async dispose() {
      stopped = true;
      await queue;
      files.clear();
      if (root) await rm(root, { recursive: true, force: true });
    },
  };
}
