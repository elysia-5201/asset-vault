/**
 * 托管缩略图缓存：预览（纯读）+ 显式确认清理。
 * 保守拒绝 root/祖先 symlink/reparse；引用按 item_images 实际路径（含 trashed/跨目录）。
 */
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve, dirname, win32, posix } from "node:path";
import { randomBytes } from "node:crypto";
import { withMediaRootLock } from "./media";

export const MEDIA_CACHE_MIN_AGE_MS = 24 * 3600 * 1000;
const TOKEN_TTL_MS = 5 * 60 * 1000;
const TOKEN_MAX = 100;
const NAME_RE = /^[0-9a-f]{16}(\.thumb\.webp|\.[a-z0-9]+)$/;
const EXT_OK = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".thumb.webp"]);

export interface MediaCacheCandidate { path: string; size: number; mtimeMs: number }
export interface MediaCacheScan {
  mediaRoot: string; totalFiles: number; totalBytes: number;
  candidates: MediaCacheCandidate[];
  protected: { referenced: number; recent: number; unknown: number; symlink: number };
  scannedAt: number;
  blockedReason?: string;
}
export interface MediaCachePreview extends MediaCacheScan { token: string; expiresAt: number }
export interface MediaCacheCleanupResult { deleted: number; failed: number; skipped: number; bytesFreed: number }

type Db = { prepare: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] } };
const dbOf = (repo: unknown): Db => (repo as { db: Db }).db;

const isNumericDir = (n: string): boolean => /^\d+$/.test(n);

/** 平台 path identity：win32 归一分隔符/./.. 并 casefold；POSIX 保持大小写语义。 */
export function refKey(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    let s = win32.normalize(p).replace(/\\/g, "/").toLowerCase();
    if (s.length > 1 && s.endsWith("/") && !/^[a-z]:\/$/.test(s)) s = s.slice(0, -1);
    return s;
  }
  return posix.normalize(p);
}

/** 全部 item_images 引用（无 item/trash 过滤），按平台 key 去重。 */
function loadRefKeys(repo: unknown, platform: NodeJS.Platform): Set<string> {
  const rows = dbOf(repo).prepare("SELECT file_path, thumb_path FROM item_images").all() as { file_path: string | null; thumb_path: string | null }[];
  const set = new Set<string>();
  for (const r of rows) {
    if (r.file_path) set.add(refKey(r.file_path, platform));
    if (r.thumb_path) set.add(refKey(r.thumb_path, platform));
  }
  return set;
}
const extOf = (n: string): string => { const i = n.indexOf("."); return i >= 0 ? n.slice(i) : ""; };

/** root/祖先为 symlink → 保守拒绝（不跟随，即使 dataDir junction 合法）。 */
export function linkBlockedReason(root: string): string {
  let cur = resolve(root);
  for (;;) {
    let st; try { st = lstatSync(cur); } catch { return ""; }
    if (st.isSymbolicLink()) return "ROOT_LINK_UNSUPPORTED";
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return "";
}

export function scanMediaCache(mediaRoot: string, repo: unknown, opts: { now?: number; platform?: NodeJS.Platform } = {}): MediaCacheScan {
  const now = opts.now ?? Date.now();
  const platform = opts.platform ?? process.platform;
  const root = resolve(mediaRoot);
  const out: MediaCacheScan = { mediaRoot: root, totalFiles: 0, totalBytes: 0, candidates: [], protected: { referenced: 0, recent: 0, unknown: 0, symlink: 0 }, scannedAt: now };
  const blocked = linkBlockedReason(root);
  if (blocked) { out.blockedReason = blocked; return out; }
  let dirs: string[] = [];
  try { dirs = readdirSync(root); } catch { return out; }
  const refs = loadRefKeys(repo, platform);
  for (const d of dirs) {
    if (!isNumericDir(d)) { out.protected.unknown++; continue; }
    const dp = join(root, d);
    let st; try { st = lstatSync(dp); } catch { continue; }
    if (st.isSymbolicLink()) { out.protected.symlink++; continue; }
    if (!st.isDirectory()) { out.protected.unknown++; continue; }
    let files: string[] = [];
    try { files = readdirSync(dp); } catch { continue; }
    for (const f of files) {
      const fp = join(dp, f);
      let fs2; try { fs2 = lstatSync(fp); } catch { continue; }
      if (fs2.isSymbolicLink()) { out.protected.symlink++; continue; }
      if (!fs2.isFile()) { out.protected.unknown++; continue; }
      out.totalFiles++; out.totalBytes += fs2.size;
      if (!NAME_RE.test(f) || !EXT_OK.has(extOf(f))) { out.protected.unknown++; continue; }
      if (fs2.nlink > 1) { out.protected.unknown++; continue; }
      if (now - fs2.mtimeMs < MEDIA_CACHE_MIN_AGE_MS) { out.protected.recent++; continue; }
      if (refs.has(refKey(fp, platform))) { out.protected.referenced++; continue; }
      out.candidates.push({ path: fp, size: fs2.size, mtimeMs: fs2.mtimeMs });
    }
  }
  return out;
}

const tokens = new Map<string, { root: string; expiresAt: number; candidates: MediaCacheCandidate[]; blockedReason?: string; platform: NodeJS.Platform }>();

function sweepTokens(now: number): void {
  for (const [k, v] of tokens) if (now > v.expiresAt) tokens.delete(k);
  while (tokens.size > TOKEN_MAX) { const first = tokens.keys().next().value as string | undefined; if (!first) break; tokens.delete(first); }
}

export function previewMediaCache(mediaRoot: string, repo: unknown, opts: { now?: number; platform?: NodeJS.Platform } = {}): MediaCachePreview {
  const now = opts.now ?? Date.now();
  const platform = opts.platform ?? process.platform;
  sweepTokens(now);
  const scan = scanMediaCache(mediaRoot, repo, { now, platform });
  const token = randomBytes(16).toString("hex");
  const expiresAt = now + TOKEN_TTL_MS;
  tokens.set(token, { root: scan.mediaRoot, expiresAt, candidates: scan.candidates, blockedReason: scan.blockedReason, platform });
  return { ...scan, token, expiresAt };
}

export function cleanupMediaCache(mediaRoot: string, repo: unknown, opts: { token: string; confirm: boolean; now?: number; platform?: NodeJS.Platform }): Promise<MediaCacheCleanupResult> {
  if (opts.confirm !== true) throw new Error("confirm=true required");
  const rec = tokens.get(opts.token);
  if (!rec) throw new Error("invalid token");
  const now = opts.now ?? Date.now();
  const platform = opts.platform ?? rec.platform;
  if (now > rec.expiresAt) { tokens.delete(opts.token); throw new Error("token expired"); }
  tokens.delete(opts.token);
  if (rec.blockedReason) return Promise.resolve({ deleted: 0, failed: 0, skipped: rec.candidates.length, bytesFreed: 0 });
  return withMediaRootLock(rec.root, async () => {
    let deleted = 0, failed = 0, skipped = 0, bytesFreed = 0;
    for (const c of rec.candidates) {
      try {
        const st = lstatSync(c.path);
        if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) { skipped++; continue; }
        if (st.mtimeMs !== c.mtimeMs || st.size !== c.size) { skipped++; continue; }
        if (loadRefKeys(repo, platform).has(refKey(c.path, platform))) { skipped++; continue; }
        unlinkSync(c.path); deleted++; bytesFreed += c.size;
      } catch (e) {
        const code = (e as { code?: string })?.code;
        if (code === "ENOENT") skipped++; else failed++;
      }
    }
    return { deleted, failed, skipped, bytesFreed };
  });
}