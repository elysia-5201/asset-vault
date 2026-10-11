/**
 * 物品分类服务（契约：docs/categories.md §3 / §5 / §6）。
 *
 * 铁律（§6，人工分类优先）：
 *  - **自动路径只经 `repo.applyAutoCategory()`**（内置 manual/confirmed 保护，绝不覆盖用户已定分类）；
 *    本文件任何地方都不得用 `repo.setItemCategory()` 去改自动归属。
 *  - 「只给建议」走 `repo.suggestItemCategory()`；重新评估后无证据则清掉过期建议（只动建议，不动归属）。
 *  - `applyCategoryEvidence()` **永不抛错**：分类是锦上添花，异常绝不阻断扫库/导入/入库/元数据更新主流程。
 */
import {
  DEFAULT_CATEGORY_THRESHOLDS, evidenceToJson, fold, recommendCategory,
  type CategoryEvidenceInput, type CategoryRecommendation, type CategoryThresholds,
} from "../../../../packages/core/src/categories/classify";
import type { CategoryLevel } from "../../../../packages/core/src/categories/taxonomy";
import type { Repo } from "../db/repo";

export interface CategoryServiceOptions { auto?: boolean; log?: (m: string) => void }

export const CATEGORY_AUTO_THRESHOLD_KEY = "category_auto_threshold";
export const CATEGORY_SUGGEST_THRESHOLD_KEY = "category_suggest_threshold";

/**
 * 证据规模上限：分类只需要"包里有什么"的样本，不需要 2 万条包内路径全喂进规则引擎
 * （规则命中去重后最多 12 条证据，喂满只会白烧 CPU；扫库建条目是热路径）。
 */
const MAX_ASSETS = 8;
const MAX_PATHS_PER_ASSET = 150;
const MAX_TAGS = 40;

export interface ApplyCategoryResult {
  ok: boolean;
  applied: boolean;
  protected: boolean;
  level: CategoryLevel;
  categoryId: string | null;
  error?: string;
}

// ---------- 阈值配置（settings；坏值回落默认，绝不 500）----------

function readThreshold(repo: Repo, key: string, fallback: number): number {
  const raw = repo.getSetting(key);
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

export function getCategoryConfig(repo: Repo): CategoryThresholds {
  return {
    autoThreshold: readThreshold(repo, CATEGORY_AUTO_THRESHOLD_KEY, DEFAULT_CATEGORY_THRESHOLDS.autoThreshold),
    suggestThreshold: readThreshold(repo, CATEGORY_SUGGEST_THRESHOLD_KEY, DEFAULT_CATEGORY_THRESHOLDS.suggestThreshold),
  };
}

/** 0..1 的有限数（接受数字或数字串）；其它一律 INVALID_INPUT 400。 */
function parseThreshold(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : (typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : NaN);
  if (!Number.isFinite(n)) throw Object.assign(new Error(label + " 必须是 0..1 的数字"), { code: "INVALID_INPUT", status: 400 });
  if (n < 0 || n > 1) throw Object.assign(new Error(label + " 必须在 0..1 之间（当前 " + n + "）"), { code: "INVALID_INPUT", status: 400 });
  return Math.round(n * 1000) / 1000;
}

/** 写阈值；只写显式给出的键（undefined/null 不动）。返回写后的完整配置。 */
export function setCategoryConfig(repo: Repo, patch: { autoThreshold?: unknown; suggestThreshold?: unknown }): CategoryThresholds {
  const auto = patch?.autoThreshold;
  if (auto !== undefined && auto !== null) repo.setSetting(CATEGORY_AUTO_THRESHOLD_KEY, String(parseThreshold(auto, "autoThreshold")));
  const suggest = patch?.suggestThreshold;
  if (suggest !== undefined && suggest !== null) repo.setSetting(CATEGORY_SUGGEST_THRESHOLD_KEY, String(parseThreshold(suggest, "suggestThreshold")));
  return getCategoryConfig(repo);
}

// ---------- 证据收集 ----------

/**
 * 收集分类证据：标题/日文标题/描述/备注/标签/BOOTH 分类/店铺 + 文件名/包内路径/unitypackage 路径。
 * 只读**已缓存**的包清单（archive_entries / unitypackage_assets），不解包、不落盘 —— 分类不得拖慢索引。
 */
export function collectEvidence(repo: Repo, itemId: number): CategoryEvidenceInput {
  const detail = repo.getItem(itemId);
  if (!detail) throw Object.assign(new Error("条目不存在: " + itemId), { code: "NOT_FOUND", status: 404 });
  const item = detail.item;
  const fileNames: string[] = [];
  const archivePaths: string[] = [];
  const unitypackagePaths: string[] = [];
  for (const a of detail.assets.slice(0, MAX_ASSETS)) {
    const name = String(a.path).split(/[\\/]/).pop();
    if (name) fileNames.push(name);
    if (a.container === "unitypackage") {
      for (const u of (repo.getUnityPackageAssets(a.id) as any[]).slice(0, MAX_PATHS_PER_ASSET)) unitypackagePaths.push(String(u?.assetPath ?? ""));
    } else {
      for (const e of (repo.getArchiveEntries(a.id) as any[]).slice(0, MAX_PATHS_PER_ASSET)) archivePaths.push(String(e?.path ?? ""));
    }
  }
  return {
    title: item.title,
    titleJa: item.title_ja,
    description: item.description,
    notes: item.notes,
    tags: detail.tags.slice(0, MAX_TAGS),
    shopName: item.shop_name,
    boothCategory: item.category_name || item.category_parent ? { name: item.category_name, parent: item.category_parent } : null,
    fileNames: fileNames.filter(Boolean),
    archivePaths,
    unitypackagePaths,
  };
}

/** 证据 → 推荐。阈值默认读 settings（可覆盖）；分类定义取数据库（用户可增删改）。 */
export function recommendForItem(
  repo: Repo,
  itemId: number,
  opts: { thresholds?: CategoryThresholds; input?: CategoryEvidenceInput } = {},
): CategoryRecommendation {
  const input = opts.input ?? collectEvidence(repo, itemId);
  return recommendCategory(input, opts.thresholds ?? getCategoryConfig(repo), repo.categoryDefs());
}

// ---------- 应用证据（永不抛）----------

/**
 * 推荐 → 落地：level=auto 且未关自动 → repo.applyAutoCategory()（manual/confirmed 保护）；
 * 其余情况只写建议（与用户已定归属一致时反而把过期建议清掉，不打扰用户）。
 * options.auto === false → 一律只写建议（不自动改归属）。
 * **绝不抛**：失败只 log 并返回 ok:false。
 */
export function applyCategoryEvidence(repo: Repo, itemId: number, opts: CategoryServiceOptions = {}): ApplyCategoryResult {
  try {
    const rec = recommendForItem(repo, itemId);
    const row = repo.itemRow(itemId);
    if (!row) return { ok: false, applied: false, protected: false, level: "none", categoryId: null, error: "条目不存在: " + itemId };
    const userDecided = row.cat_source === "manual" || row.cat_source === "confirmed";
    const sameAsCurrent = row.cat_id === rec.categoryId && (row.cat_sub_id ?? null) === (rec.subCategoryId ?? null);

    if (!rec.categoryId) {
      // 没有任何证据 → 保持未分类；顺手清掉上一轮的过期建议（只动建议，不动归属）
      if (row.cat_suggest_id) { try { repo.clearItemCategorySuggestion(itemId); } catch { /* 忽略 */ } }
      return { ok: true, applied: false, protected: userDecided, level: "none", categoryId: null };
    }

    const payload = {
      categoryId: rec.categoryId, subCategoryId: rec.subCategoryId, confidence: rec.confidence,
      reason: rec.reason, evidence: evidenceToJson(rec),
    };
    if (rec.level === "auto" && opts.auto !== false) {
      const res = repo.applyAutoCategory(itemId, payload);
      return { ok: true, applied: res.applied, protected: res.protected, level: rec.level, categoryId: rec.categoryId };
    }
    if (userDecided && sameAsCurrent) {
      if (row.cat_suggest_id) { try { repo.clearItemCategorySuggestion(itemId); } catch { /* 忽略 */ } }
      return { ok: true, applied: false, protected: true, level: rec.level, categoryId: rec.categoryId };
    }
    repo.suggestItemCategory(itemId, payload);
    return { ok: true, applied: false, protected: userDecided, level: rec.level, categoryId: rec.categoryId };
  } catch (e) {
    const message = String((e as any)?.message ?? e);
    try { opts.log?.("category: item " + itemId + " 自动分类失败（已忽略）: " + message); } catch { /* log 自己也不许抛 */ }
    return { ok: false, applied: false, protected: false, level: "none", categoryId: null, error: message };
  }
}

// ---------- 批量重跑（/api/categories/reclassify）----------

export interface ReclassifyOptions extends CategoryServiceOptions {
  itemIds?: number[];
  onlyUncategorized?: boolean;
  /** 默认 false：只写建议、不改归属（安全默认） */
  apply?: boolean;
  all?: boolean;
  limit?: number;
}

export interface ReclassifyResult {
  scanned: number; applied: number; suggested: number; cleared: number; skipped: number; protected: number;
  results: {
    itemId: number; categoryId: string | null; subCategoryId: string | null; confidence: number;
    level: CategoryLevel; applied: boolean; protected: boolean; reason: string;
  }[];
}

export const DEFAULT_RECLASSIFY_LIMIT = 500;
export const MAX_RECLASSIFY_LIMIT = 5000;

/** 扫描范围：itemIds > onlyUncategorized > all；三者都没有 → 400（不静默全库改分类）。 */
function scopeItemIds(repo: Repo, opts: ReclassifyOptions): number[] {
  const limit = Math.min(MAX_RECLASSIFY_LIMIT, Math.max(1, Math.floor(Number(opts.limit) > 0 ? Number(opts.limit) : DEFAULT_RECLASSIFY_LIMIT)));
  const explicit = [...new Set((opts.itemIds ?? []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];
  if (explicit.length > 0) return explicit.slice(0, limit);
  if (opts.onlyUncategorized !== true && opts.all !== true) {
    throw Object.assign(new Error("需要 itemIds / onlyUncategorized / all 之一来指定范围"), { code: "INVALID_INPUT", status: 400 });
  }
  const uncategorized = opts.onlyUncategorized === true;
  const out: number[] = [];
  const page = 500; // repo.listItems 单页上限
  for (let offset = 0; out.length < limit; offset += page) {
    const res = repo.listItems({ uncategorized, includeTrashed: false, limit: page, offset });
    for (const it of res.items) { if (out.length >= limit) break; out.push(it.id); }
    if (res.items.length === 0 || offset + page >= res.total) break;
  }
  return out;
}

/**
 * 批量重跑分类：
 *  - level=auto 且 apply=true → applyAutoCategory（manual/confirmed 记 protected，不被覆盖）；
 *  - 其余（suggest 级 / apply=false / 受保护）→ 只写建议（与当前归属一致则清掉过期建议）；
 *  - 无证据 → 清掉过期建议，保持未分类（不为凑自动分类率硬塞，§2）。
 * 单条失败只记进 results[].reason，不影响其它条目。
 */
export function reclassifyCategories(repo: Repo, opts: ReclassifyOptions = {}): ReclassifyResult {
  const ids = scopeItemIds(repo, opts);
  const apply = opts.apply === true;
  const thresholds = getCategoryConfig(repo);
  const out: ReclassifyResult = { scanned: 0, applied: 0, suggested: 0, cleared: 0, skipped: 0, protected: 0, results: [] };
  for (const itemId of ids) {
    out.scanned++;
    const entry: ReclassifyResult["results"][number] = {
      itemId, categoryId: null, subCategoryId: null, confidence: 0, level: "none", applied: false, protected: false, reason: "",
    };
    try {
      const row = repo.itemRow(itemId);
      if (!row) { entry.reason = "条目不存在"; out.skipped++; out.results.push(entry); continue; }
      const rec = recommendForItem(repo, itemId, { thresholds });
      const userDecided = row.cat_source === "manual" || row.cat_source === "confirmed";
      const sameAsCurrent = row.cat_id === rec.categoryId && (row.cat_sub_id ?? null) === (rec.subCategoryId ?? null);
      entry.categoryId = rec.categoryId;
      entry.subCategoryId = rec.subCategoryId;
      entry.confidence = rec.confidence;
      entry.level = rec.level;
      entry.reason = rec.reason;
      if (!rec.categoryId) {
        if (row.cat_suggest_id) { repo.clearItemCategorySuggestion(itemId); out.cleared++; }
        else out.skipped++;
      } else if (rec.level === "auto" && apply && opts.auto !== false) {
        const res = repo.applyAutoCategory(itemId, {
          categoryId: rec.categoryId, subCategoryId: rec.subCategoryId, confidence: rec.confidence,
          reason: rec.reason, evidence: evidenceToJson(rec),
        });
        entry.applied = res.applied;
        entry.protected = res.protected;
        if (res.applied) out.applied++;
        if (res.protected) {
          out.protected++;
          // applyAutoCategory 的内部语义：与用户既有选择一致 → 清建议（没有建议就是空转）；不一致 → 写建议。
          // 计数器互斥：applied / suggested / cleared / skipped 之和恒等于 scanned。
          if (sameAsCurrent) { if (row.cat_suggest_id) out.cleared++; else out.skipped++; }
          else out.suggested++;
        }
      } else if (sameAsCurrent) {
        // 推荐 == 当前归属 → 没有建议可给（别给"已经设对了"的条目再挂一条待确认建议）。
        // 用户已定的情况记 protected（他的选择没被覆盖）。
        if (userDecided) { out.protected++; entry.protected = true; }
        if (row.cat_suggest_id) { repo.clearItemCategorySuggestion(itemId); out.cleared++; }
        else out.skipped++;
      } else {
        repo.suggestItemCategory(itemId, {
          categoryId: rec.categoryId, subCategoryId: rec.subCategoryId, confidence: rec.confidence,
          reason: rec.reason, evidence: evidenceToJson(rec),
        });
        out.suggested++;
        if (userDecided) { out.protected++; entry.protected = true; }
      }
    } catch (e) {
      entry.reason = "错误: " + String((e as any)?.message ?? e);
      out.skipped++;
    }
    out.results.push(entry);
  }
  try {
    opts.log?.("category reclassify: scanned=" + out.scanned + " applied=" + out.applied + " suggested=" + out.suggested
      + " cleared=" + out.cleared + " protected=" + out.protected + " skipped=" + out.skipped);
  } catch { /* log 自己也不许抛 */ }
  return out;
}

// ---------- 建议标签（v3 §7：只建议，绝不自动写 item_tags）----------

export interface SuggestedTag { name: string; reason: string }

/**
 * 建议标签规则：只给「标签表里已存在、且该条目还没有」的默认标签提建议。
 * 关键词只在**已有证据**（标题/日文标题/描述/备注/文件名/包内路径）里找，命中即建议 —— 不落库、不写 item_tags。
 * 关键词刻意取得保守（宁可漏、不要误报）：标签建议是给人看的，噪音预算很低。
 */
const TAG_SUGGEST_RULES: readonly { name: string; keywords: readonly string[] }[] = [
  { name: "PhysBones", keywords: ["physbone", "phys bone", "揺れもの", "揺れモノ", "ゆれもの"] },
  { name: "Modular Avatar", keywords: ["modular avatar", "modularavatar", "modular-avatar", "ndmf", "マージャブル"] },
  { name: "Quest 兼容", keywords: ["vrcquesttools", "quest対応", "quest 対応", "quest版", "oculus quest", "quest standalone"] },
  { name: "免费", keywords: ["無料", "フリー素材", "free素材", "free asset"] },
  { name: "哥特风", keywords: ["ゴシック", "gothic", "ゴスロリ"] },
  { name: "可爱风", keywords: ["かわいい", "可愛", "cute", "kawaii", "ファンシー"] },
];

/**
 * 该条目的**建议标签**（只读派生，契约 §7：仅建议，绝不自动写入 item_tags）。
 *  - 安全忽略：规则指向的标签不在标签表里（用户删掉了 / 还没播种）→ 跳过，不复活、不报错。
 *  - 已有该标签的条目不再建议（去噪）。
 *  - **永不抛**：任何异常 → 返回 []（标签建议不许阻断详情页）。
 */
export function suggestTagsFor(repo: Repo, itemId: number, limit = 6): SuggestedTag[] {
  try {
    const detail = repo.getItem(itemId);
    if (!detail) return [];
    const ev = collectEvidence(repo, itemId);
    const hay = [
      ev.title, ev.titleJa, ev.description, ev.notes,
      ...(ev.fileNames ?? []), ...(ev.archivePaths ?? []), ...(ev.unitypackagePaths ?? []),
    ].filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => fold(s));
    if (hay.length === 0) return [];
    const has = new Set(detail.tags.map((t) => (t.includes(":") ? t.slice(t.indexOf(":") + 1) : t)));
    const known = new Set((repo.listTags() as any[]).map((t: any) => String(t.name)));
    const out: SuggestedTag[] = [];
    for (const rule of TAG_SUGGEST_RULES) {
      if (out.length >= limit) break;
      if (has.has(rule.name) || !known.has(rule.name)) continue;
      const hit = rule.keywords.find((kw) => hay.some((h) => h.includes(fold(kw))));
      if (hit) out.push({ name: rule.name, reason: "证据含「" + hit + "」" });
    }
    return out;
  } catch {
    return [];
  }
}
