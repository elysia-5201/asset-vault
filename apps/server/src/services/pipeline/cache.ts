/**
 * 派生缓存（v0.6.0）
 *
 * 缓存的是**可重建的派生数据**（目录清单 / unitypackage 结构 / 深度元数据），
 * 不是用户数据，也绝不落在素材目录里。
 *
 * 身份键 = kind + 内容身份 + 解析器/规则版本 + 限制指纹：
 *   - 内容身份优先用完整 sha256；没有 sha 时只能用 size:mtime 作为**弱候选**，
 *     调用方必须知道它不等价于"内容相同"（weak=true 会写进 meta，诊断面板可见）。
 *   - 解析器版本变了 → 只有该 kind 的键变，缩略图/哈希不受影响。
 *   - 限制参数变了（limitsHash）→ 目录缓存失效，避免用旧上限的结果冒充新上限。
 *
 * 写入一律 tmp + rename（原子替换）：写到一半崩溃的临时文件不会被识别为有效缓存。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Repo } from "../../db/repo";
import { now, sha256Text } from "../../util";

export interface CacheKeyParts {
  kind: string;
  /** 内容身份：sha256（强）或 size:mtime（弱） */
  identity: string;
  /** 解析器/规则版本 */
  versionKey: string;
  /** 影响结果的限制指纹（可选） */
  limitsHash?: string;
  /** 其他影响输出的参数（如缩略图尺寸） */
  extra?: Record<string, string | number | boolean>;
}

/** 生成稳定缓存键；不含路径、不含文件名。 */
export function cacheKey(parts: CacheKeyParts): string {
  const extra = parts.extra ? JSON.stringify(parts.extra, Object.keys(parts.extra).sort()) : "";
  return sha256Text([parts.kind, parts.identity, parts.versionKey, parts.limitsHash ?? "", extra].join("\u0000"));
}

export interface CacheMeta {
  kind: string;
  contentSha?: string | null;
  versionKey: string;
  weak?: boolean;
}

/** 流水线只需要这两个能力：读不到就自己算，算完写回。 */
export interface CacheLike {
  get<T>(kind: string, key: string): Promise<T | null>;
  put(kind: string, key: string, value: unknown, meta: CacheMeta): Promise<{ bytes: number }>;
}

export interface CacheStats {
  entries: number;
  bytes: number;
  hits: number;
  hitRate: number;
  maxBytes: number;
  oldest: string | null;
}

export class DerivedCache implements CacheLike {
  private gets = 0;
  private hits = 0;
  /** 上次 touch 时间（同一 key 30s 内不重复写 DB，避免读缓存反而放大写压力） */
  private touched = new Map<string, number>();

  constructor(
    private readonly root: string,
    private readonly repo: Repo,
    private readonly log: (m: string) => void = () => {},
  ) {
    mkdirSync(root, { recursive: true });
  }

  dirFor(kind: string): string {
    if (!/^[a-z0-9._-]+$/i.test(kind)) throw new Error("非法缓存 kind: " + kind);
    const d = join(this.root, kind);
    mkdirSync(d, { recursive: true });
    return d;
  }
  pathFor(key: string, kind: string): string {
    if (!/^[a-f0-9]{16,64}$/.test(key)) throw new Error("非法缓存 key: " + key);
    return join(this.dirFor(kind), key.slice(0, 2) + "-" + key + ".json");
  }

  /** 命中返回解析后的值；损坏/缺失一律 null（并清掉坏条目）。 */
  async get<T>(kind: string, key: string): Promise<T | null> {
    this.gets++;
    const entry = this.repo.getCacheEntry(key);
    if (!entry || entry.state !== "ready") return null;
    try {
      if (!existsSync(entry.file_path)) { this.repo.deleteCacheEntry(key); return null; }
      const txt = readFileSync(entry.file_path, "utf8");
      const value = JSON.parse(txt) as T;
      this.hits++;
      this.touch(key);
      return value;
    } catch (e) {
      this.log("cache corrupt " + key + ": " + String((e as Error)?.message ?? e));
      this.drop(key, entry.file_path, "corrupt");
      return null;
    }
  }

  /** 原子写入：先写 .tmp-<pid>-<rand>，再 rename 覆盖。 */
  async put(kind: string, key: string, value: unknown, meta: CacheMeta): Promise<{ bytes: number }> {
    const file = this.pathFor(key, kind);
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true });
    const tmp = file + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2, 10);
    const body = JSON.stringify(value);
    try {
      writeFileSync(tmp, body);
      renameSync(tmp, file);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
    try {
      this.repo.upsertCacheEntry({ key, kind, contentSha: meta.contentSha ?? null, versionKey: meta.versionKey, filePath: file, bytes: Buffer.byteLength(body) });
    } catch (e) {
      // DB 失败不能留下无引用孤儿文件（gc 只遍历 DB 条目）
      try { unlinkSync(file); } catch { /* ignore */ }
      throw e;
    }
    return { bytes: Buffer.byteLength(body) };
  }

  private touch(key: string): void {
    const last = this.touched.get(key) ?? 0;
    if (Date.now() - last < 30_000) return;
    this.touched.set(key, Date.now());
    try { this.repo.touchCacheEntry(key); } catch { /* 读路径不因统计失败而失败 */ }
  }

  /** 删除单条（文件只允许在缓存根内）。 */
  drop(key: string, filePath?: string, reason = "manual"): void {
    const p = filePath ?? this.repo.getCacheEntry(key)?.file_path;
    if (p) this.unlinkInsideRoot(p);
    try { this.repo.deleteCacheEntry(key); } catch { /* ignore */ }
    this.log("cache drop " + key + " (" + reason + ")");
  }

  /** 清理崩溃残留：缓存根内的 *.tmp-*；绝不递归到缓存根之外。 */
  pruneTemp(): number {
    let removed = 0;
    const walk = (dir: string, depth: number) => {
      if (depth > 2) return;
      let names: string[] = [];
      try { names = readdirSync(dir); } catch { return; }
      for (const n of names) {
        const p = join(dir, n);
        let st; try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) { walk(p, depth + 1); continue; }
        if (n.includes(".tmp-")) { try { unlinkSync(p); removed++; } catch { /* ignore */ } }
      }
    };
    walk(this.root, 0);
    return removed;
  }

  /**
   * LRU + 过期淘汰：先删超过 maxAgeDays 的，再按 last_used_at 最旧删到 maxBytes 以下。
   * keepEntries 是"最近使用"的保护带，避免把正在用的清掉。
   */
  gc(opts: { maxBytes: number; maxAgeDays: number; keepEntries: number }): { removed: number; bytes: number; expired: number } {
    let removed = 0, expired = 0, bytesFreed = 0;
    const cutoff = Date.now() - opts.maxAgeDays * 86_400_000;
    for (const e of this.repo.listCacheEntries(undefined, 10_000)) {
      if (new Date(e.last_used_at).getTime() < cutoff) {
        bytesFreed += Number(e.bytes) || 0; this.drop(e.key, e.file_path, "expired"); expired++; removed++;
      }
    }
    let total = this.repo.cacheStats().bytes;
    if (total > opts.maxBytes) {
      const oldest = this.repo.oldestCacheEntries(10_000).filter((e) => e.state === "ready");
      const protectedCount = Math.min(opts.keepEntries, oldest.length);
      const removable = oldest.slice(0, Math.max(0, oldest.length - protectedCount));
      for (const e of removable) {
        if (total <= opts.maxBytes) break;
        total -= Number(e.bytes) || 0; bytesFreed += Number(e.bytes) || 0;
        this.drop(e.key, e.file_path, "lru"); removed++;
      }
    }
    if (removed) this.log("cache gc: removed=" + removed + " expired=" + expired + " bytes=" + bytesFreed);
    return { removed, bytes: bytesFreed, expired };
  }

  stats(maxBytes: number): CacheStats {
    const s = this.repo.cacheStats();
    const oldest = this.repo.listCacheEntries(undefined, 1_000_000).slice(-1)[0]?.last_used_at ?? null;
    return { entries: s.entries, bytes: s.bytes, hits: s.hits, hitRate: this.gets ? this.hits / this.gets : 0, maxBytes, oldest };
  }

  /** 清空（排障用；只动缓存根，不动素材）。 */
  clear(kind?: string): number {
    let n = 0;
    for (const e of this.repo.listCacheEntries(kind, 10_000)) { this.drop(e.key, e.file_path, "clear"); n++; }
    return n;
  }

  private unlinkInsideRoot(p: string): void {
    try {
      const resolved = resolve(p);
      const rootResolved = resolve(this.root);
      if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) {
        this.log("cache path outside root, refused: " + p);
        return;
      }
      unlinkSync(resolved);
    } catch { /* 已不存在 */ }
    void now;
  }
}
