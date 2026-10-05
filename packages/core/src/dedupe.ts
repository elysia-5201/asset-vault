/**
 * dedupe.ts — 素材库多级去重（纯函数，core 所有）
 *
 * 只用"文件级 SHA256 + 条目结构（路径/大小）+ unitypackage GUID 清单"做判定，
 * 解包、落库、查候选都留给服务层（apps/server/src/services/dedupe.ts）。
 *
 * 相似度口径（冻结）：
 *   1) 两边 SHA256 都非空且相等 → similarity=1、level=exact、diff 全空（字节完全相同）；
 *   2) 否则 simEntries = (same + 0.5*changed) / union，union = same+changed+added+removed；
 *   3) GUID 一路（两边都有 GUID 清单时）simGuids = sameG / unionG；
 *   4) similarity = max(simEntries ?? 0, simGuids ?? 0)，保留 4 位；
 *      === 1 且 diff 全空 → same-content（内容一致、文件名/压缩方式不同），否则 >= 阈值 → near。
 */
import { createHash } from "node:crypto";
import { normalizePath } from "./pathnorm";

export interface EntryLike { path: string; size: number }

export interface Fingerprint {
  assetId: number; itemId: number; container: string;
  fileSha: string | null; structHash: string | null; guidHash: string | null;
  entries: EntryLike[]; guids: string[]; versionKey: string | null;
}

export interface DuplicateDiff { added: EntryLike[]; removed: EntryLike[]; changed: EntryLike[] }

export interface DuplicateMatch {
  otherAssetId: number; otherItemId: number;
  similarity: number;                                  // 0..1，保留 4 位
  level: "exact" | "same-content" | "near";
  reason: string;                                      // 中文一句话
  diff: DuplicateDiff;
}

/** diff 每类最多返回多少条（整包目录可能上万条，响应不能跟着膨胀）。 */
export const MAX_DIFF_ITEMS = 50;

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * 归一化路径 → 条目。同一路径重复出现时取 size 最大的一条
 * （解包工具偶尔会把同路径列两次，取大值才不会把正常包判成"改过"）。
 */
function entryMap(entries: EntryLike[] | null | undefined): Map<string, EntryLike> {
  const m = new Map<string, EntryLike>();
  for (const e of entries ?? []) {
    const raw = String(e?.path ?? "");
    const key = normalizePath(raw);
    if (!key) continue;
    const size = Number.isFinite(Number(e?.size)) ? Number(e.size) : 0;
    const cur = m.get(key);
    if (!cur || size > cur.size) m.set(key, { path: raw, size });
  }
  return m;
}

/** 结构指纹：归一化路径 + 大小（与上面同一去重口径），按 path 排序后 "path|size\n" 拼接再 sha256。 */
export function structHashOf(entries: EntryLike[]): string {
  const lines: string[] = [];
  for (const [p, e] of entryMap(entries)) lines.push(p + "|" + e.size);
  lines.sort();
  return sha256Hex(lines.map((l) => l + "\n").join(""));
}

/** GUID 指纹：小写去重、字典序排序后直接拼接再 sha256（GUID 定长，无分隔符也唯一）。 */
export function guidHashOf(guids: string[]): string {
  const set = new Set<string>();
  for (const g of guids ?? []) {
    const s = String(g ?? "").trim().toLowerCase();
    if (s) set.add(s);
  }
  return sha256Hex([...set].sort().join(""));
}

// 版本号：显式前缀（v / ver / version / バージョン / 版本 / 版）优先；没有前缀时只认"形如 x.y 且前后是分隔符"的写法。
// 反例：纯数字文件名（"2025.zip"）不是版本号——单个数字段必须有至少一个点才算。
const VER_PREFIXED = /(?:^|[^0-9a-z])(?:v|ver|version|バージョン|版本|版)[\s._-]{0,2}(\d+(?:[._]\d+){0,3})/;
const VER_BARE = /(?:^|[^0-9a-z])(\d{1,4}(?:\.\d{1,4}){1,3})(?![0-9])/;

/** 从文件名/标题抽版本号（"1.2" / "1.2.0"）；抽不到返回 null。全角数字/字母先 NFKC 折半角。 */
export function parseVersionKey(name: string): string | null {
  if (typeof name !== "string" || name === "") return null;
  const s = name.normalize("NFKC").toLowerCase();
  const hit = VER_PREFIXED.exec(s) ?? VER_BARE.exec(s);
  if (!hit) return null;
  return hit[1]!.replace(/[._]/g, ".");
}

/** 统一入口：算相似度并按 minSimilarity 过滤（低于阈值返回 null）。 */
export function similarityOf(a: Fingerprint, b: Fingerprint, minSimilarity: number): DuplicateMatch | null {
  const min = Number.isFinite(minSimilarity) ? minSimilarity : 0;

  // 字节完全相同：内容一致的最强证据，直接短路（diff 无意义）
  if (a.fileSha && b.fileSha && a.fileSha === b.fileSha) {
    return { otherAssetId: b.assetId, otherItemId: b.itemId, similarity: 1, level: "exact", reason: "字节完全相同（SHA256 一致）", diff: { added: [], removed: [], changed: [] } };
  }

  const am = entryMap(a.entries);
  const bm = entryMap(b.entries);
  const addedAll: { key: string; entry: EntryLike }[] = [];
  const removedAll: { key: string; entry: EntryLike }[] = [];
  const changedAll: { key: string; entry: EntryLike }[] = [];
  let same = 0;
  for (const [p, ea] of am) {
    const eb = bm.get(p);
    if (!eb) { removedAll.push({ key: p, entry: ea }); continue; }
    if (ea.size === eb.size) same++;
    // 修改的条目取 b 侧（"相对 a 的变化"里，修改后的大小才是新值）
    else changedAll.push({ key: p, entry: eb });
  }
  for (const [p, eb] of bm) if (!am.has(p)) addedAll.push({ key: p, entry: eb });

  const union = same + changedAll.length + addedAll.length + removedAll.length;
  const simEntries = union === 0 ? null : (same + 0.5 * changedAll.length) / union;

  // GUID 一路：两边都有 GUID 清单才比（unitypackage；压缩包内含 .unitypackage 时由服务层抽解出来）
  let sameG = 0;
  let unionG = 0;
  let simGuids: number | null = null;
  if (a.guids.length > 0 && b.guids.length > 0) {
    const as = new Set(a.guids.map((g) => String(g).toLowerCase()));
    const bs = new Set(b.guids.map((g) => String(g).toLowerCase()));
    for (const g of as) if (bs.has(g)) sameG++;
    unionG = new Set([...as, ...bs]).size;
    simGuids = unionG === 0 ? null : sameG / unionG;
  } else if (a.guidHash && b.guidHash && a.guidHash === b.guidHash) {
    // 压缩包只有内层包的聚合哈希、拿不到 GUID 清单：哈希相等即可判定 GUID 集合一致
    simGuids = 1;
  }

  const similarity = round4(Math.max(simEntries ?? 0, simGuids ?? 0));
  if (similarity < min) return null;

  const byPath = (arr: { key: string; entry: EntryLike }[]): EntryLike[] =>
    arr.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)).slice(0, MAX_DIFF_ITEMS).map((x) => x.entry);
  const diff: DuplicateDiff = { added: byPath(addedAll), removed: byPath(removedAll), changed: byPath(changedAll) };
  const counts = "新增 " + addedAll.length + " / 删除 " + removedAll.length + " / 修改 " + changedAll.length;

  const diffEmpty = addedAll.length === 0 && removedAll.length === 0 && changedAll.length === 0;
  if (similarity === 1 && diffEmpty) {
    return { otherAssetId: b.assetId, otherItemId: b.itemId, similarity, level: "same-content", reason: "内容一致（条目完全相同，" + counts + "）：文件名或压缩方式不同", diff };
  }
  const pct = (similarity * 100).toFixed(1);
  const guidPart = unionG > 0 ? "，GUID 交集 " + sameG + "/" + unionG : "";
  const reason = "结构相似 " + pct + "%（" + counts + "；条目相同 " + same + guidPart + "）";
  return { otherAssetId: b.assetId, otherItemId: b.itemId, similarity, level: "near", reason, diff };
}

/** 不算 null 的版本：minSimilarity=0（调用方自己决定还要不要这个匹配）。 */
export function compareFingerprints(a: Fingerprint, b: Fingerprint): DuplicateMatch {
  return similarityOf(a, b, 0)!;
}
