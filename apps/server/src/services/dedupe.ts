/**
 * dedupe.ts（服务层）— 素材库多级去重的签名落库与查询。
 *
 * 签名只读已缓存的目录清单（archive_entries / unitypackage_assets），不重新解包；
 * 只有"压缩包内含 .unitypackage"才真正抽包读 GUID（有 IO 成本，超时/失败一律放弃）。
 * 相似度算法本身在 packages/core/src/dedupe.ts（纯函数、可单测）。
 */
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  guidHashOf, parseVersionKey, similarityOf, structHashOf,
  type DuplicateMatch, type EntryLike, type Fingerprint,
} from "../../../../packages/core/src/dedupe";
import { listUnityPackage } from "../../../../packages/core/src/unitypackage";
import type { Repo } from "../db/repo";
import { baseName, listUnityPackageCandidates, stageUnityPackage } from "./unity";

export interface ComputedSignature {
  structHash: string | null; guidHash: string | null;
  entryCount: number; totalSize: number; versionKey: string | null;
}

export interface SignatureRow {
  asset_id: number; file_sha: string | null; struct_hash: string | null; guid_hash: string | null;
  entry_count: number; total_size: number; version_key: string | null; computed_at: string;
}

export interface ItemDuplicateMatch extends DuplicateMatch {
  otherTitle: string; otherPath: string; otherVersionKey: string | null;
}

export interface DuplicateGroupItem { itemId: number; title: string; assetId: number; path: string; size: number; versionKey: string | null }
export interface DuplicateGroup { key: string; similarity: number; items: DuplicateGroupItem[] }

const ARCHIVE_CONTAINERS = new Set(["zip", "7z", "rar"]);
/** 抽内层包读 GUID 的超时（这个路径要真解包，超时就放弃 guidHash，不拖住索引）。 */
const GUID_SCAN_TIMEOUT_MS = 15000;
/** 一个压缩包里最多抽几个内层包算 GUID 清单。 */
const MAX_GUID_PACKAGES = 3;
/** 单次查重的候选上限（哈希快路径 + 同容器条目数相近的一批）。 */
const CANDIDATE_LIMIT = 400;
/** 库里"还没算过签名"的老资产按大小兜底纳入候选的上限（就地补算，避免拖慢接口）。 */
const UNSIGNED_CANDIDATE_LIMIT = 50;
/** 分组时单个哈希桶/近似桶的规模上限（桶内两两比，防 O(n²) 爆炸）。 */
const BUCKET_LIMIT = 64;

/** Repo 没暴露底层连接（repo.ts 不在本次改动范围内），去重服务借用它的 db 读写签名。 */
const dbOf = (repo: Repo): Database.Database => (repo as unknown as { db: Database.Database }).db;

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.9);

/** 超时即返回 null（Promise 的拒绝也吞掉：这条路径不允许把异常抛给调用方）。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
  });
}

// ---------------------------------------------------------------- 签名

export function getSignatureRow(repo: Repo, assetId: number): SignatureRow | null {
  return (dbOf(repo).prepare("SELECT * FROM asset_signatures WHERE asset_id=?").get(assetId) as SignatureRow) ?? null;
}

function upsertSignature(repo: Repo, assetId: number, fileSha: string | null, sig: ComputedSignature): void {
  dbOf(repo).prepare(`INSERT INTO asset_signatures(asset_id, file_sha, struct_hash, guid_hash, entry_count, total_size, version_key, computed_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(asset_id) DO UPDATE SET file_sha=excluded.file_sha, struct_hash=excluded.struct_hash, guid_hash=excluded.guid_hash,
      entry_count=excluded.entry_count, total_size=excluded.total_size, version_key=excluded.version_key, computed_at=excluded.computed_at`)
    .run(assetId, fileSha, sig.structHash, sig.guidHash, sig.entryCount, sig.totalSize, sig.versionKey, new Date().toISOString());
}

/** 条目清单：归档走 archive_entries，unitypackage 走 unitypackage_assets；其余容器没有结构可比。 */
function entriesOf(repo: Repo, asset: { id: number; container: string }): EntryLike[] {
  if (asset.container === "unitypackage") {
    return (repo.getUnityPackageAssets(asset.id) as any[]).map((r) => ({ path: String(r.assetPath ?? ""), size: Number(r.size) || 0 }));
  }
  if (ARCHIVE_CONTAINERS.has(asset.container)) {
    return (repo.getArchiveEntries(asset.id) as any[]).filter((r) => !r.isDir)
      .map((r) => ({ path: String(r.path ?? ""), size: Number(r.size) || 0 }));
  }
  return [];
}

/** 版本号：优先文件名，其次条目标题（"Danzai_Bunny_v1.2.zip" 认不出来时标题往往有 "v1.2 対応"）。 */
function versionKeyOf(repo: Repo, assetPath: string, itemId: number): string | null {
  const fromName = parseVersionKey(baseName(assetPath));
  if (fromName) return fromName;
  const row = (dbOf(repo).prepare("SELECT title FROM items WHERE id=?").get(itemId) as { title?: string } | undefined);
  return parseVersionKey(String(row?.title ?? ""));
}

/**
 * 压缩包里其实塞着 .unitypackage：抽出来读 GUID 清单。
 * 这里要真解包（IO 成本），超时/任何失败都只返回空数组，绝不抛出。
 */
async function innerPackageGuids(repo: Repo, asset: { id: number; item_id: number }): Promise<string[]> {
  const entries = repo.getArchiveEntries(asset.id) as any[];
  const maybe = entries.some((e) => !e.isDir && (/\.unitypackage$/i.test(String(e.path)) || (/\.zip$/i.test(String(e.path)) && Number(e.size) > 4096)));
  if (!maybe) return [];
  const run = (async (): Promise<string[]> => {
    const scan = await listUnityPackageCandidates(repo, asset.item_id);
    const cands = scan.packages.filter((c) => c.assetId === asset.id).sort((a, b) => b.size - a.size).slice(0, MAX_GUID_PACKAGES);
    if (cands.length === 0) return [];
    const out = new Set<string>();
    const dir = mkdtempSync(join(tmpdir(), "av-dedupe-guid-"));
    try {
      for (const c of cands) {
        try {
          const staged = await stageUnityPackage(c, dir);
          const listing = await listUnityPackage(staged.path, { maxAssets: 20000 });
          for (const a of listing.assets) if (a.guid) out.add(String(a.guid).toLowerCase());
        } catch { /* 单个内层包失败不影响其它 */ }
      }
    } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
    return [...out];
  })();
  return (await withTimeout(run, GUID_SCAN_TIMEOUT_MS)) ?? [];
}

/** 算一条资产的签名并 upsert；资产不存在返回 null。不抛错（调用方是索引/查重热路径）。 */
export async function computeSignature(repo: Repo, assetId: number): Promise<ComputedSignature | null> {
  const asset = repo.getAsset(assetId);
  if (!asset) return null;
  const entries = entriesOf(repo, asset);
  // 空清单不构成结构指纹：否则两个"目录没解出来"的包会互相比中
  const structHash = entries.length > 0 ? structHashOf(entries) : null;
  const guids = asset.container === "unitypackage"
    ? (repo.getUnityPackageAssets(assetId) as any[]).map((r) => String(r.guid ?? "")).filter(Boolean)
    : ARCHIVE_CONTAINERS.has(asset.container) ? await innerPackageGuids(repo, asset) : [];
  const guidHash = guids.length > 0 ? guidHashOf(guids) : null;
  const sig: ComputedSignature = {
    structHash, guidHash, entryCount: entries.length,
    totalSize: entries.reduce((n, e) => n + e.size, 0),
    versionKey: versionKeyOf(repo, asset.path, asset.item_id),
  };
  upsertSignature(repo, assetId, asset.sha256 ?? null, sig);
  return sig;
}

/** 读指纹：优先用 asset_signatures，缺失的字段就地由已缓存清单补算（不重新解包）。 */
export function fingerprintOf(repo: Repo, assetId: number): Fingerprint | null {
  const asset = repo.getAsset(assetId);
  if (!asset) return null;
  const row = getSignatureRow(repo, assetId);
  const entries = entriesOf(repo, asset);
  const guids = asset.container === "unitypackage"
    ? (repo.getUnityPackageAssets(assetId) as any[]).map((r) => String(r.guid ?? "")).filter(Boolean)
    : [];
  return {
    assetId: asset.id, itemId: asset.item_id, container: asset.container,
    fileSha: row?.file_sha ?? asset.sha256 ?? null,
    structHash: row?.struct_hash ?? (entries.length > 0 ? structHashOf(entries) : null),
    guidHash: row?.guid_hash ?? (guids.length > 0 ? guidHashOf(guids) : null),
    entries, guids,
    versionKey: row?.version_key ?? parseVersionKey(baseName(asset.path)),
  };
}

// ---------------------------------------------------------------- 条目查重

/** 候选资产：先哈希快路径，再补"同容器 + 条目数 ±25%"与"同容器 + 体积相近但还没签名"的老资产。 */
async function candidateAssetIds(repo: Repo, fp: Fingerprint, excludeItemId: number): Promise<number[]> {
  const db = dbOf(repo);
  const ids = new Set<number>();
  const fast = db.prepare(`SELECT s.asset_id AS id FROM asset_signatures s JOIN assets a ON a.id = s.asset_id
      WHERE a.status <> 'trashed' AND a.item_id <> ?
        AND ((s.struct_hash IS NOT NULL AND s.struct_hash = ?)
          OR (s.file_sha IS NOT NULL AND s.file_sha = ?)
          OR (s.guid_hash IS NOT NULL AND s.guid_hash = ?))
      LIMIT ?`).all(excludeItemId, fp.structHash, fp.fileSha, fp.guidHash, CANDIDATE_LIMIT) as any[];
  for (const r of fast) ids.add(Number(r.id));

  const n = fp.entries.length;
  const near = db.prepare(`SELECT s.asset_id AS id FROM asset_signatures s JOIN assets a ON a.id = s.asset_id
      WHERE a.status <> 'trashed' AND a.item_id <> ? AND a.container = ?
        AND s.entry_count BETWEEN ? AND ? LIMIT ?`)
    .all(excludeItemId, fp.container, Math.floor(n * 0.75), Math.ceil(n * 1.25), CANDIDATE_LIMIT) as any[];
  for (const r of near) ids.add(Number(r.id));

  // 老库（本次改动之前扫进来的）没有签名行：同容器、体积 ±25% 的按大小兜一批。
  // 这些资产就地由已缓存清单算指纹（纯内存，不重解包），没清单的自然会被相似度过滤掉。
  const size = Number(repo.getAsset(fp.assetId)?.size ?? 0);
  const unsigned = db.prepare(`SELECT a.id FROM assets a LEFT JOIN asset_signatures s ON s.asset_id = a.id
      WHERE a.status <> 'trashed' AND a.item_id <> ? AND a.container = ? AND s.asset_id IS NULL
        AND a.size BETWEEN ? AND ? LIMIT ?`)
    .all(excludeItemId, fp.container, Math.floor(size * 0.75), Math.ceil(size * 1.25), UNSIGNED_CANDIDATE_LIMIT) as any[];
  for (const r of unsigned) ids.add(Number(r.id));

  ids.delete(fp.assetId);
  return [...ids];
}

/**
 * 某条目的重复资产。找不到重复返回 []。
 * rescan=true 时对本条目的资产强制重算签名；缺失的签名一律就地补算（不做整库重算）。
 */
export async function findDuplicatesForItem(repo: Repo, itemId: number, opts: { minSimilarity?: number; limit?: number; rescan?: boolean } = {}): Promise<ItemDuplicateMatch[]> {
  const min = clamp01(opts.minSimilarity ?? 0.9);
  const limit = Math.max(1, opts.limit ?? 20);
  const mine = repo.listAssets(itemId);
  if (mine.length === 0) return [];

  for (const a of mine) {
    if (opts.rescan || !getSignatureRow(repo, a.id)) {
      try { await computeSignature(repo, a.id); } catch { /* 单条失败不影响其它资产 */ }
    }
  }

  const best = new Map<number, ItemDuplicateMatch>();
  for (const a of mine) {
    const fa = fingerprintOf(repo, a.id);
    if (!fa) continue;
    const cands = await candidateAssetIds(repo, fa, itemId);
    for (const otherId of cands) {
      const fb = fingerprintOf(repo, otherId);
      if (!fb) continue;
      const m = similarityOf(fa, fb, min);
      if (!m) continue;
      const cur = best.get(m.otherAssetId);
      if (cur && cur.similarity >= m.similarity) continue;   // 同一 otherAssetId 只留最高分
      const other = repo.getAsset(m.otherAssetId);
      const item = (dbOf(repo).prepare("SELECT title FROM items WHERE id=?").get(fb.itemId) as { title?: string } | undefined);
      best.set(m.otherAssetId, {
        ...m,
        otherTitle: String(item?.title ?? ""),
        otherPath: String(other?.path ?? ""),
        otherVersionKey: getSignatureRow(repo, m.otherAssetId)?.version_key ?? fb.versionKey,
      });
    }
  }
  return [...best.values()]
    .sort((x, y) => y.similarity - x.similarity || x.otherAssetId - y.otherAssetId)
    .slice(0, limit);
}

// ---------------------------------------------------------------- 全库分组

/**
 * 跨条目的重复组：哈希桶（哈希相等 ⟹ 必然相似）+ 同容器近似桶（桶内两两比），再并查集合并。
 * 只输出 >= minSimilarity 且**跨条目**的组（同一 item 的两个资产不算"素材重复"）。
 */
export async function listDuplicateGroups(repo: Repo, opts: { minSimilarity?: number; limit?: number; recompute?: boolean } = {}): Promise<DuplicateGroup[]> {
  const min = clamp01(opts.minSimilarity ?? 0.9);
  const limit = Math.max(1, opts.limit ?? 100);
  if (opts.recompute) await recomputeSignatures(repo, {});

  const rows = dbOf(repo).prepare(`SELECT s.asset_id, s.file_sha, s.struct_hash, s.guid_hash, s.entry_count, s.version_key,
      a.item_id, a.container, a.path, a.size, i.title
    FROM asset_signatures s JOIN assets a ON a.id = s.asset_id JOIN items i ON i.id = a.item_id
    WHERE a.status <> 'trashed' ORDER BY s.asset_id`).all() as any[];
  if (rows.length < 2) return [];

  const push = (m: Map<string, any[]>, k: string, v: any): void => { const l = m.get(k) ?? []; l.push(v); m.set(k, l); };
  const hashBuckets = new Map<string, any[]>();
  const nearBuckets = new Map<string, any[]>();
  for (const r of rows) {
    if (r.file_sha) push(hashBuckets, "sha:" + r.file_sha, r);
    if (r.struct_hash) push(hashBuckets, "struct:" + r.struct_hash, r);
    if (r.guid_hash) push(hashBuckets, "guid:" + r.guid_hash, r);
    push(nearBuckets, r.container + ":" + Math.round(Math.log2(Math.max(1, Number(r.entry_count) || 1))), r);
  }

  // pair -> similarity（同一对可能被多个桶命中；哈希桶给出的是精确值，取最大即可）
  const pairs = new Map<string, number>();
  const addPair = (x: number, y: number, sim: number): void => {
    if (x === y) return;
    const key = Math.min(x, y) + "-" + Math.max(x, y);
    const cur = pairs.get(key);
    if (cur === undefined || sim > cur) pairs.set(key, sim);
  };

  for (const bucket of hashBuckets.values()) {
    const list = bucket.slice(0, BUCKET_LIMIT);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) addPair(Number(list[i].asset_id), Number(list[j].asset_id), 1);
  }
  const fpCache = new Map<number, Fingerprint | null>();
  for (const bucket of nearBuckets.values()) {
    const list = bucket.slice(0, BUCKET_LIMIT);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const ia = Number(list[i].asset_id), ib = Number(list[j].asset_id);
        if (pairs.has(Math.min(ia, ib) + "-" + Math.max(ia, ib))) continue;   // 已由哈希桶精确判定
        const fa = cachedFingerprint(repo, ia, fpCache);
        const fb = cachedFingerprint(repo, ib, fpCache);
        if (!fa || !fb) continue;
        const m = similarityOf(fa, fb, min);
        if (m) addPair(ia, ib, m.similarity);
      }
    }
  }
  if (pairs.size === 0) return [];

  // 并查集
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const pairList: { a: number; b: number; similarity: number }[] = [];
  for (const [key, similarity] of pairs) {
    const [a, b] = key.split("-").map(Number) as [number, number];
    pairList.push({ a, b, similarity });
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  }

  const rootOf = new Map<number, number>();
  for (const p of pairList) { rootOf.set(p.a, find(p.a)); rootOf.set(p.b, find(p.b)); }
  const members = new Map<string, any[]>();
  for (const r of rows) {
    const root = rootOf.get(Number(r.asset_id));
    if (root !== undefined) push(members, String(root), r);
  }
  const rootSim = new Map<number, number>();
  for (const p of pairList) {
    const root = rootOf.get(p.a)!;
    const cur = rootSim.get(root);
    rootSim.set(root, cur === undefined ? p.similarity : Math.min(cur, p.similarity));
  }

  const groups: DuplicateGroup[] = [];
  for (const [rootKey, list] of members) {
    const items: DuplicateGroupItem[] = list.map((r) => ({
      itemId: Number(r.item_id), title: String(r.title ?? ""), assetId: Number(r.asset_id),
      path: String(r.path ?? ""), size: Number(r.size) || 0, versionKey: r.version_key ?? null,
    })).sort((x, y) => x.itemId - y.itemId || x.assetId - y.assetId);
    if (new Set(items.map((i) => i.itemId)).size < 2) continue;   // 只报跨条目的重复
    groups.push({ key: "dup:" + Math.min(...items.map((i) => i.assetId)), similarity: rootSim.get(Number(rootKey)) ?? 1, items });
  }
  groups.sort((x, y) => y.similarity - x.similarity || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return groups.slice(0, limit);
}

function cachedFingerprint(repo: Repo, assetId: number, cache: Map<number, Fingerprint | null>): Fingerprint | null {
  if (!cache.has(assetId)) cache.set(assetId, fingerprintOf(repo, assetId));
  return cache.get(assetId) ?? null;
}

// ---------------------------------------------------------------- 批量重算

export interface RecomputeResult { scanned: number; updated: number; remaining: number; ms: number }

/**
 * 批量重算签名：只处理"缺失"或"已 stale"（文件哈希变了 / 资产被 touch 过）的资产——
 * 全量重算在大库上必然超时，而新鲜签名重算也是同一个值。
 */
export async function recomputeSignatures(repo: Repo, opts: { budgetMs?: number } = {}): Promise<RecomputeResult> {
  const started = Date.now();
  const deadline = started + (opts.budgetMs ?? 45000);
  const rows = dbOf(repo).prepare(`SELECT a.id, a.sha256 AS asset_sha, a.last_verified_at,
      s.asset_id AS sig_id, s.file_sha, s.computed_at
    FROM assets a LEFT JOIN asset_signatures s ON s.asset_id = a.id
    WHERE a.status <> 'trashed' ORDER BY a.id`).all() as any[];
  let scanned = 0, updated = 0, remaining = 0;
  for (const r of rows) {
    const stale = !r.sig_id
      || String(r.file_sha ?? "") !== String(r.asset_sha ?? "")
      || (!!r.computed_at && !!r.last_verified_at && String(r.computed_at) < String(r.last_verified_at));
    if (!stale) continue;
    if (Date.now() > deadline) { remaining++; continue; }
    scanned++;
    try { if (await computeSignature(repo, Number(r.id))) updated++; } catch { /* 单条失败继续 */ }
  }
  return { scanned, updated, remaining, ms: Date.now() - started };
}
