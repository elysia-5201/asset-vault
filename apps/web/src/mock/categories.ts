/**
 * 内置 mock 的「物品分类」状态与工具（v2）——形状严格同 docs/categories.md §4。
 *
 * 说明：分类定义的真源是 @core/categories/taxonomy 的 DEFAULT_TAXONOMY；这里持有一份**可变副本**
 * （mock 里 PATCH/POST/DELETE /api/categories 会改它），条目归属直接写在 ItemRow 的 cat_* 列上，
 * 因此 cardOf / listItems 的投影与真实后端同形。
 */
import { DEFAULT_CATEGORY_THRESHOLDS } from "@core/categories/classify";
import { DEFAULT_TAXONOMY, type CategoryDef, type CategoryLevel } from "@core/categories/taxonomy";
import type { CategoryAssignment, CategoryNode, CategoryRefSource, CategorySuggestion, ItemRow } from "@core/contracts";

export interface MockCategoryConfig { autoThreshold: number; suggestThreshold: number }

/** v2 物品分类列：mock 默认未分类（分类由 /api/categories 端点提供） */
export const NO_CAT = {
  cat_id: null, cat_sub_id: null, cat_source: null, cat_confidence: null, cat_reason: null, cat_evidence: null, cat_assigned_at: null,
  cat_suggest_id: null, cat_suggest_sub_id: null, cat_suggest_confidence: null, cat_suggest_reason: null, cat_suggest_evidence: null, cat_suggest_at: null,
} as const;

export const categoryDefs: CategoryDef[] = DEFAULT_TAXONOMY.map((d) => ({ ...d }));
export const categoryConfig: MockCategoryConfig = { ...DEFAULT_CATEGORY_THRESHOLDS };

// 故意停用一个子分类：前端下拉/筛选必须跳过它（enabled=false），但**已归属**的条目仍要显示它的名字。
const DISABLED_SEED = "hair.texture";
{
  const d = categoryDefs.find((x) => x.id === DISABLED_SEED);
  if (d) d.enabled = false;
}

const bySort = (a: CategoryDef, b: CategoryDef): number => a.sort - b.sort || a.id.localeCompare(b.id);

export function catById(id: string | null | undefined): CategoryDef | null {
  if (!id) return null;
  return categoryDefs.find((d) => d.id === id) ?? null;
}
export function catName(id: string | null | undefined): string | null {
  const d = catById(id);
  return d ? d.name : (id ?? null);
}
export function catTops(): CategoryDef[] { return categoryDefs.filter((d) => d.parentId === null).sort(bySort); }
export function catChildren(parentId: string): CategoryDef[] { return categoryDefs.filter((d) => d.parentId === parentId).sort(bySort); }

/** 条目的分类路径（主 + 子，存在的才收）。 */
export function catPath(item: ItemRow): string[] {
  const out: string[] = [];
  if (item.cat_id && catById(item.cat_id)) out.push(item.cat_id);
  if (item.cat_sub_id && catById(item.cat_sub_id)) out.push(item.cat_sub_id);
  return out;
}
/** item 的分类是否命中筛选节点（与 repo.ts:70-79 的 SQL 语义一致）。 */
export function catMatches(item: ItemRow, ids: string[], match: "any" | "all"): boolean {
  if (!ids.length) return true;
  const path = catPath(item);
  return match === "all" ? ids.every((c) => path.includes(c)) : ids.some((c) => path.includes(c));
}

function parseJson(raw: string | null): unknown[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}

export function assignmentOf(item: ItemRow): CategoryAssignment | null {
  if (!item.cat_id) return null;
  return {
    categoryId: item.cat_id,
    categoryName: catName(item.cat_id),
    subCategoryId: item.cat_sub_id,
    subCategoryName: catName(item.cat_sub_id),
    source: item.cat_source ?? null,
    confidence: item.cat_confidence,
    evidence: parseJson(item.cat_evidence),
    reason: item.cat_reason,
    assignedAt: item.cat_assigned_at,
  };
}

export function suggestionOf(item: ItemRow): CategorySuggestion | null {
  if (!item.cat_suggest_id) return null;
  return {
    categoryId: item.cat_suggest_id,
    categoryName: catName(item.cat_suggest_id) ?? item.cat_suggest_id,
    subCategoryId: item.cat_suggest_sub_id,
    subCategoryName: catName(item.cat_suggest_sub_id),
    confidence: item.cat_suggest_confidence ?? 0,
    reason: item.cat_suggest_reason,
    evidence: parseJson(item.cat_suggest_evidence),
    suggestedAt: item.cat_suggest_at,
  };
}

export interface SetCategoryInput {
  categoryId: string | null;
  subCategoryId?: string | null;
  source?: CategoryRefSource;
  confidence?: number | null;
  reason?: string | null;
  evidence?: string | null;
}

/** 用户路径：无条件写；子分类不属于主分类 → 清空；同时清建议（与 repo.setItemCategory 同语义）。 */
export function setItemCategory(item: ItemRow, input: SetCategoryInput, now: string): void {
  const main = input.categoryId ?? null;
  if (!main) {
    Object.assign(item, {
      cat_id: null, cat_sub_id: null, cat_source: null, cat_confidence: null, cat_reason: null,
      cat_evidence: null, cat_assigned_at: null,
    });
  } else {
    const def = catById(main);
    if (!def) throw new Error("分类不存在：" + main);
    if (def.parentId !== null) throw new Error("主分类不能是子分类：" + main);
    let sub = input.subCategoryId ?? null;
    const subDef = catById(sub);
    if (sub && (!subDef || subDef.parentId !== main)) sub = null; // 不再属于该主分类 → 清空
    Object.assign(item, {
      cat_id: main, cat_sub_id: sub, cat_source: input.source ?? "manual",
      cat_confidence: input.confidence ?? null, cat_reason: input.reason ?? null,
      cat_evidence: input.evidence ?? null, cat_assigned_at: now,
    });
  }
  item.cat_suggest_id = null; item.cat_suggest_sub_id = null; item.cat_suggest_confidence = null;
  item.cat_suggest_reason = null; item.cat_suggest_evidence = null; item.cat_suggest_at = null;
}

export interface CategoryStats {
  counts: { id: string; name: string; parentId: string | null; count: number; topCount: number; owned: number; favorite: number }[];
  uncategorized: number;
  pending: number;
  total: number;
  missingFiles: number;
}

export function treeOf(items: ItemRow[]): CategoryNode[] {
  const live = items.filter((i) => i.status !== "trashed");
  const countOf = (id: string): number => live.filter((i) => catPath(i).includes(id)).length;
  const tree: CategoryNode[] = catTops().map((t) => ({
    id: t.id, name: t.name, parentId: null, sort: t.sort, enabled: t.enabled, builtin: t.builtin, itemCount: countOf(t.id),
    children: catChildren(t.id).map((c) => ({
      id: c.id, name: c.name, parentId: t.id, sort: c.sort, enabled: c.enabled, builtin: c.builtin, itemCount: countOf(c.id),
    })),
  }));
  return tree;
}

export function statsOf(items: ItemRow[], isOwned: (itemId: number) => boolean, hasFile: (itemId: number) => boolean): CategoryStats {
  const live = items.filter((i) => i.status !== "trashed");
  const counts = categoryDefs.map((d) => {
    const scope = live.filter((i) => catPath(i).includes(d.id));
    const topScope = d.parentId === null ? scope.filter((i) => !i.cat_sub_id) : scope;
    return {
      id: d.id, name: d.name, parentId: d.parentId,
      count: scope.length, topCount: topScope.length,
      owned: scope.filter((i) => isOwned(i.id)).length,
      favorite: scope.filter((i) => i.favorite === 1).length,
    };
  });
  return {
    counts,
    uncategorized: live.filter((i) => !i.cat_id).length,
    pending: live.filter((i) => i.cat_suggest_id !== null).length,
    total: live.length,
    missingFiles: live.filter((i) => !hasFile(i.id)).length,
  };
}

// ---------- mock 内的「自动推荐」（够用即可：真实规则在 packages/core/src/categories/classify.ts） ----------
interface MockRule { re: RegExp; categoryId: string; subCategoryId: string | null }
const RULES: MockRule[] = [
  { re: /セーラー|衣装|服|dress|hoodie|shirt|skirt|パーカー|巫女|衣装|ブラウス/i, categoryId: "clothing", subCategoryId: "tops" },
  { re: /髪|ヘア|hair|ウィッグ|ウィッグ/i, categoryId: "hair", subCategoryId: "model" },
  { re: /アクセサリ|ネックレス|ピアス|耳飾|指輪|飾り|accessor/i, categoryId: "accessories", subCategoryId: "other" },
  { re: /シェーダー|shader|liltoon|poiyomi|レンダリング/i, categoryId: "shaders", subCategoryId: "shader" },
  { re: /modular\s*avatar|ツール|tool|kit|キット/i, categoryId: "tools", subCategoryId: "modular_avatar" },
  { re: /テクスチャ|texture|マテリアル|material/i, categoryId: "textures", subCategoryId: "texture" },
  { re: /アニメ|モーション|animation|ダンス|ポーズ|モーション/i, categoryId: "animation", subCategoryId: "anim" },
];

export interface MockRecommendation {
  categoryId: string | null;
  subCategoryId: string | null;
  confidence: number;
  level: CategoryLevel;
  reason: string;
  evidence: string | null;
}

/** 极简推荐：标题命中权重 1.0、标签命中 0.6；置信度 = min(1, score/2)，阈值取 categoryConfig。 */
export function recommendFor(item: ItemRow, tags: string[]): MockRecommendation {
  const title = item.title ?? "";
  const hits: { field: string; matched: string; gain: number; cat: string; sub: string | null }[] = [];
  for (const r of RULES) {
    const m = r.re.exec(title);
    if (m) hits.push({ field: "title", matched: m[0], gain: 1, cat: r.categoryId, sub: r.subCategoryId });
  }
  for (const t of tags) {
    for (const r of RULES) {
      const m = r.re.exec(t);
      if (m) hits.push({ field: "tag", matched: t, gain: 0.6, cat: r.categoryId, sub: r.subCategoryId });
    }
  }
  if (!hits.length) {
    return { categoryId: null, subCategoryId: null, confidence: 0, level: "none", reason: "没有命中任何分类关键词（保持未分类，不硬塞）", evidence: null };
  }
  const scoreBy = new Map<string, number>();
  for (const h of hits) scoreBy.set(h.cat, (scoreBy.get(h.cat) ?? 0) + h.gain);
  const ranked = [...scoreBy].sort((a, b) => b[1] - a[1]);
  const [cat, score] = ranked[0]!;
  const runnerUp = ranked[1]?.[1] ?? 0;
  let confidence = Math.min(1, score / 2);
  if (runnerUp > 0 && (score - runnerUp) / score < 0.35) confidence *= 0.6;
  const sub = hits.find((h) => h.cat === cat)?.sub ?? null;
  const level: CategoryLevel = confidence >= categoryConfig.autoThreshold ? "auto" : confidence >= categoryConfig.suggestThreshold ? "suggest" : "none";
  const top = hits.filter((h) => h.cat === cat).map((h) => h.field + ":" + h.matched).join(" · ");
  return {
    categoryId: cat, subCategoryId: sub, confidence, level,
    reason: "命中「" + top + "」（得分 " + score.toFixed(1) + "，第二候选 " + runnerUp.toFixed(1) + "）",
    evidence: JSON.stringify(hits.filter((h) => h.cat === cat).map((h) => ({ field: h.field, matched: h.matched, gain: h.gain, cat: h.cat, sub: h.sub }))),
  };
}

