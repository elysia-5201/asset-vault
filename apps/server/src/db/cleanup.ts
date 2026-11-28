/**
 * 整理待办（cleanup-todos spec §3/§6.1，P4-T1）——四类规则派生 + 计数 + local 策略。
 *
 * 纯读：不写 items/assets/item_images/item_avatars/cleanup_ignores；不扫盘、不补签名、不建 job。
 * 待办不落表：每次按 §3 的 SQL 实时派生；忽略只读 cleanup_ignores（写函数属 P4-T2）。
 * 卡片一律取 repo.getItem() 的真实 ItemCard（repo.toCard 是私有实现：不复制、不虚造形状、不把义务推给 HTTP）。
 */
import { AppError, type ItemCard } from "../../../../packages/core/src/contracts";
import type Database from "better-sqlite3";
import { compileSearch } from "../services/search";
import type { Repo } from "./repo";

export type CleanupRule = "missing_cover" | "missing_source" | "unlinked_model" | "missing_file";
export type LocalSourcePolicy = "exclude_local" | "include_local";
export type CleanupIgnoredMode = "hide" | "show" | "only";
export type CleanupSort = "updated" | "title";

export const CLEANUP_RULES: readonly CleanupRule[] = ["missing_cover", "missing_source", "unlinked_model", "missing_file"];

export interface CleanupQuery {
  rule?: CleanupRule;
  ignored?: CleanupIgnoredMode;
  q?: string;
  avatarIds?: number[];
  categoryIds?: string[];
  sort?: CleanupSort;
  /** 必填、无服务端默认：缺失/非法 → 400 INVALID_INPUT（details.code=LOCAL_POLICY_REQUIRED）。 */
  localSourcePolicy: LocalSourcePolicy;
  limit?: number;
  offset?: number;
}

export interface CleanupRuleCount { total: number; ignored: number }

export interface CleanupCounts {
  /** 四类规则命中行数之和（不受 ignored 过滤影响）。 */
  total: number;
  missing_cover: CleanupRuleCount;
  missing_source: CleanupRuleCount & { localExcluded: number };
  unlinked_model: CleanupRuleCount;
  missing_file: CleanupRuleCount;
}

/** 一行 = (item, rule)。resolved 只在 ignored=only 的忽略行上求值，普通待办行恒为 null。 */
export type CleanupRow =
  | { item: ItemCard; rule: "missing_cover"; ignored: boolean; resolved: boolean | null; evidence: { imageCount: number } }
  | { item: ItemCard; rule: "missing_source"; ignored: boolean; resolved: boolean | null; evidence: { sourceSite: string; sourceGone: number } }
  | { item: ItemCard; rule: "unlinked_model"; ignored: boolean; resolved: boolean | null; evidence: { itemAvatarCount: number; assetAvatarCount: number } }
  | { item: ItemCard; rule: "missing_file"; ignored: boolean; resolved: boolean | null; evidence: { missingAssetCount: number } };

export interface CleanupTodosResult { total: number; counts: CleanupCounts; items: CleanupRow[] }

const RULE_VALUES: ReadonlySet<string> = new Set<string>(CLEANUP_RULES);
const IGNORED_VALUES: ReadonlySet<string> = new Set(["hide", "show", "only"]);
const SORT_VALUES: ReadonlySet<string> = new Set(["updated", "title"]);

/** 基础范围（所有规则共用，spec §3）：归档/回收站不进待办。 */
const BASE_SCOPE = "i.status NOT IN ('archived','trashed')";
/** 空白来源判定：SQLite 默认 TRIM(X) 只剥空格，tab/CR/LF 必须用 charlist（spec §3.2 P3-1）。 */
const BLANK_SOURCE = "(i.source_url IS NULL OR TRIM(i.source_url, ' ' || char(9) || char(10) || char(13)) = '')";

/** 四类规则谓词（spec §3 逐字口径）。missing_source 的 ? 是 localSourcePolicy。 */
const RULE_PREDICATE: Record<CleanupRule, string> = {
  missing_cover: "NOT EXISTS (SELECT 1 FROM item_images im WHERE im.id = i.cover_image_id) AND NOT EXISTS (SELECT 1 FROM item_images im2 WHERE im2.item_id = i.id)",
  missing_source: BLANK_SOURCE + " AND i.source_gone = 0 AND (? = 'include_local' OR i.source_site <> 'local')",
  unlinked_model: "NOT EXISTS (SELECT 1 FROM item_avatars ia WHERE ia.item_id = i.id AND ia.match <> 'exclude')",
  missing_file: "EXISTS (SELECT 1 FROM assets a WHERE a.item_id = i.id AND a.status = 'missing')",
};

/** 缺参/非法一律 400 INVALID_INPUT + details.code=LOCAL_POLICY_REQUIRED；不静默选默认。 */
export function parseLocalSourcePolicy(raw: unknown): LocalSourcePolicy {
  if (raw === "exclude_local" || raw === "include_local") return raw;
  throw new AppError("INVALID_INPUT", "localSourcePolicy 必填：exclude_local | include_local（无服务端默认）", 400, { code: "LOCAL_POLICY_REQUIRED" });
}

function pickEnum<T extends string>(raw: unknown, allowed: ReadonlySet<string>, field: string, dflt?: T): T | undefined {
  if (raw === undefined || raw === null || raw === "") return dflt;
  if (typeof raw === "string" && allowed.has(raw)) return raw as T;
  throw new AppError("INVALID_INPUT", field + " 非法：" + String(raw));
}

/** 四类规则的行集（UNION ALL）：每行 (item_id, rule)，基础范围固定。 */
function ruleUnion(policy: LocalSourcePolicy): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const rule of CLEANUP_RULES) {
    parts.push("SELECT i.id AS item_id, '" + rule + "' AS rule FROM items i WHERE " + BASE_SCOPE + " AND " + RULE_PREDICATE[rule]);
    if (rule === "missing_source") params.push(policy);
  }
  return { sql: parts.join("\nUNION ALL\n"), params };
}

/** Keep cleanup rule scope and reuse catalog search for text and advanced filters. */
function filterClause(db: Database.Database, q: CleanupQuery): { sql: string; params: unknown[] } {
  const w: string[] = [];
  const params: unknown[] = [];
  const text = (q.q ?? "").trim();
  if (text) {
    const search = compileSearch(db, text);
    if (search.ranked) {
      w.push("i.id IN (" + search.prefix + "SELECT item_id FROM search_rank)");
      params.push(...search.values);
    }
    for (const clause of search.clauses) { w.push("(" + clause.sql + ")"); params.push(...clause.values); }
  }
  const avatarIds = (q.avatarIds ?? []).filter((n) => Number.isFinite(n));
  if (avatarIds.length > 0) {
    w.push("EXISTS (SELECT 1 FROM item_avatars ia WHERE ia.item_id=i.id AND ia.match<>'exclude' AND ia.avatar_id IN (" +
      avatarIds.map(() => "?").join(",") + "))");
    params.push(...avatarIds);
  }
  const categoryIds = (q.categoryIds ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (categoryIds.length > 0) {
    const ph = categoryIds.map(() => "?").join(",");
    w.push("(i.cat_id IN (" + ph + ") OR i.cat_sub_id IN (" + ph + "))");
    params.push(...categoryIds, ...categoryIds);
  }
  return { sql: w.length > 0 ? " AND " + w.join(" AND ") : "", params };
}

interface RawRow {
  item_id: number; rule: string; source_site: string; source_gone: number;
  image_count: number; item_avatar_count: number; asset_avatar_count: number; missing_asset_count: number;
  is_ignored?: number; hit?: number;
}

/** 真实卡片：repo.getItem() 返回 ItemDetail（ItemCard 超集），去掉详情专属字段后即完整 ItemCard。 */
function cardGetter(repo: Repo): (id: number) => ItemCard {
  const cache = new Map<number, ItemCard>();
  return (id: number): ItemCard => {
    const hit = cache.get(id);
    if (hit) return hit;
    const detail = repo.getItem(id);
    if (!detail) throw new Error("cleanup: item " + id + " 在同步查询期间消失");
    const { item: _row, images: _images, assets: _assets, notes: _notes, description: _description, ...card } = detail;
    cache.set(id, card);
    return card;
  };
}

function makeRow(rule: CleanupRule, card: ItemCard, ignored: boolean, resolved: boolean | null, r: RawRow): CleanupRow {
  switch (rule) {
    case "missing_cover":
      return { item: card, rule, ignored, resolved, evidence: { imageCount: Number(r.image_count) } };
    case "missing_source":
      return { item: card, rule, ignored, resolved, evidence: { sourceSite: String(r.source_site), sourceGone: Number(r.source_gone) } };
    case "unlinked_model":
      return { item: card, rule, ignored, resolved, evidence: { itemAvatarCount: Number(r.item_avatar_count), assetAvatarCount: Number(r.asset_avatar_count) } };
    case "missing_file":
      return { item: card, rule, ignored, resolved, evidence: { missingAssetCount: Number(r.missing_asset_count) } };
  }
}

/**
 * 整理待办列表（纯读）。
 * - total：当前列表行数（应用 rule/q/avatar/category/ignored 后）；ignored=only 时是忽略行数（含已解决）。
 * - counts：规则命中计数（除 rule/ignored 外的筛选生效；ignored 不影响）。
 * - 同一 item 命中多个 rule → 多行。
 */
export function listCleanupTodos(repo: Repo, q: CleanupQuery): CleanupTodosResult {
  const policy = parseLocalSourcePolicy(q.localSourcePolicy);
  const rule = pickEnum<CleanupRule>(q.rule, RULE_VALUES, "rule");
  const ignored = pickEnum<CleanupIgnoredMode>(q.ignored, IGNORED_VALUES, "ignored", "hide") ?? "hide";
  const sort = pickEnum<CleanupSort>(q.sort, SORT_VALUES, "sort", "updated") ?? "updated";
  const limit = Math.min(200, Math.max(1, Number.isFinite(q.limit) ? Math.trunc(q.limit as number) : 50));
  const offset = Math.max(0, Number.isFinite(q.offset) ? Math.trunc(q.offset as number) : 0);
  const db = repo.connection;
  const union = ruleUnion(policy);
  const filters = filterClause(db, q);
  const ruleParams: unknown[] = rule ? [rule] : [];
  const cardOf = cardGetter(repo);

  // ---- counts：规则命中 + 其中已忽略（LEFT JOIN 忽略表，不受 ignored 过滤影响）----
  const counts: CleanupCounts = {
    total: 0,
    missing_cover: { total: 0, ignored: 0 },
    missing_source: { total: 0, ignored: 0, localExcluded: 0 },
    unlinked_model: { total: 0, ignored: 0 },
    missing_file: { total: 0, ignored: 0 },
  };
  const countRows = db.prepare(
    "SELECT u.rule AS rule, COUNT(*) AS total, SUM(CASE WHEN ci.item_id IS NULL THEN 0 ELSE 1 END) AS ignored" +
    " FROM (" + union.sql + ") u JOIN items i ON i.id = u.item_id" +
    " LEFT JOIN cleanup_ignores ci ON ci.item_id = u.item_id AND ci.rule = u.rule" +
    " WHERE 1=1" + filters.sql + " GROUP BY u.rule"
  ).all(...union.params, ...filters.params) as Array<{ rule: string; total: number; ignored: number }>;
  for (const row of countRows) {
    const t = Number(row.total); const ig = Number(row.ignored ?? 0);
    switch (row.rule) {
      case "missing_cover": counts.missing_cover = { total: t, ignored: ig }; break;
      case "missing_source": counts.missing_source = { total: t, ignored: ig, localExcluded: 0 }; break;
      case "unlinked_model": counts.unlinked_model = { total: t, ignored: ig }; break;
      case "missing_file": counts.missing_file = { total: t, ignored: ig }; break;
    }
    counts.total += t;
  }
  // localExcluded：被 exclude_local 排除的 local 条目数（不是待办数；include_local 时恒 0）。
  counts.missing_source.localExcluded = policy === "exclude_local"
    ? Number((db.prepare("SELECT COUNT(*) AS n FROM items i WHERE " + BASE_SCOPE + " AND " + BLANK_SOURCE +
        " AND i.source_gone = 0 AND i.source_site = 'local'" + filters.sql).get(...filters.params) as { n: number }).n)
    : 0;

  const evidenceCols =
    "i.source_site AS source_site, i.source_gone AS source_gone," +
    " (SELECT COUNT(*) FROM item_images im WHERE im.item_id = X.item_id) AS image_count," +
    " (SELECT COUNT(*) FROM item_avatars ia WHERE ia.item_id = X.item_id) AS item_avatar_count," +
    " (SELECT COUNT(*) FROM asset_avatars aa JOIN assets a ON a.id = aa.asset_id WHERE a.item_id = X.item_id AND a.status<>'trashed') AS asset_avatar_count," +
    " (SELECT COUNT(*) FROM assets a2 WHERE a2.item_id = X.item_id AND a2.status = 'missing') AS missing_asset_count";

  if (ignored !== "only") {
    const ignoredFilter = ignored === "hide"
      ? " AND NOT EXISTS (SELECT 1 FROM cleanup_ignores ci2 WHERE ci2.item_id = u.item_id AND ci2.rule = u.rule)"
      : "";
    const order = sort === "title" ? "i.title COLLATE NOCASE ASC, i.id ASC, u.rule ASC" : "i.updated_at DESC, i.id DESC, u.rule ASC";
    const total = Number((db.prepare("SELECT COUNT(*) AS n FROM (" + union.sql + ") u JOIN items i ON i.id = u.item_id" +
      " WHERE 1=1" + filters.sql + (rule ? " AND u.rule = ?" : "") + ignoredFilter)
      .get(...union.params, ...filters.params, ...ruleParams) as { n: number }).n);
    const rows = db.prepare("SELECT u.item_id AS item_id, u.rule AS rule, " + evidenceCols.replace(/X\.item_id/g, "u.item_id") +
      ", EXISTS (SELECT 1 FROM cleanup_ignores ci3 WHERE ci3.item_id = u.item_id AND ci3.rule = u.rule) AS is_ignored" +
      " FROM (" + union.sql + ") u JOIN items i ON i.id = u.item_id" +
      " WHERE 1=1" + filters.sql + (rule ? " AND u.rule = ?" : "") + ignoredFilter +
      " ORDER BY " + order + " LIMIT ? OFFSET ?")
      .all(...union.params, ...filters.params, ...ruleParams, limit, offset) as RawRow[];
    const items = rows.map((r) => makeRow(r.rule as CleanupRule, cardOf(Number(r.item_id)), Number(r.is_ignored) === 1, null, r));
    return { total, counts, items };
  }

  // ---- ignored=only：以忽略表为驱动（含已解决/陈旧行）；列表本身仍套固定基础范围（Global 约束 1），
  //      只有 resolved 的单条求值不套（spec §6.2：归档/回收站不算“问题已解决”，但也不在默认列表里）----
  const hitCase = allRulesHitSql();
  const order = sort === "title" ? "i.title COLLATE NOCASE ASC, i.id ASC, ci.rule ASC" : "i.updated_at DESC, i.id DESC, ci.rule ASC";
  const onlyRule = rule ? " AND ci.rule = ?" : "";
  const total = Number((db.prepare("SELECT COUNT(*) AS n FROM cleanup_ignores ci JOIN items i ON i.id = ci.item_id" +
    " WHERE " + BASE_SCOPE + filters.sql + onlyRule).get(...filters.params, ...ruleParams) as { n: number }).n);
  const rows = db.prepare("SELECT ci.item_id AS item_id, ci.rule AS rule, " + evidenceCols.replace(/X\.item_id/g, "ci.item_id") +
    ", " + hitCase + " AS hit" +
    " FROM cleanup_ignores ci JOIN items i ON i.id = ci.item_id" +
    " WHERE " + BASE_SCOPE + filters.sql + onlyRule +
    " ORDER BY " + order + " LIMIT ? OFFSET ?")
    .all(policy, ...filters.params, ...ruleParams, limit, offset) as RawRow[];
  const items = rows.map((r) => makeRow(r.rule as CleanupRule, cardOf(Number(r.item_id)), true, Number(r.hit) !== 1, r));
  return { total, counts, items };
}

// ===== P4-T2：忽略/resolved 与保存筛选（spec §6.2/§6.3）=====

const RESOLVED_VALUES: ReadonlySet<string> = new Set(["any", "true", "false"]);

/** 管理视图的一行忽略：resolved 按 (item, rule) 单条求值，不套基础范围。 */
export interface CleanupIgnoreRow {
  itemId: number;
  rule: CleanupRule;
  note: string | null;
  ignoredAt: string;
  resolved: boolean;
  item: { id: number; title: string; status: string };
}

export interface CleanupIgnoreQuery {
  resolved?: "any" | "true" | "false";
  /** 必填、无服务端默认：缺失/非法 → 400 INVALID_INPUT（details.code=LOCAL_POLICY_REQUIRED）。 */
  localSourcePolicy: LocalSourcePolicy;
  limit?: number;
  offset?: number;
}

export interface CleanupIgnoreInput {
  itemId: number;
  rule: CleanupRule;
  note?: string | null;
}

/** 保存筛选的结构（严格校验；localSourcePolicy 必填，无默认）。 */
export interface CleanupFilter {
  rule?: CleanupRule;
  q?: string;
  avatarIds?: number[];
  categoryIds?: string[];
  ignored?: CleanupIgnoredMode;
  localSourcePolicy: LocalSourcePolicy;
  sort?: CleanupSort;
  limit?: number;
}

export interface CleanupFilterRow {
  id: number;
  name: string;
  filter: CleanupFilter;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CleanupFilterCreateInput { name: string; filter: CleanupFilter }
export interface CleanupFilterPatchInput { name?: string; filter?: CleanupFilter; expectedVersion: number }

interface IgnoreRaw {
  item_id: number; rule: string; note: string | null; ignored_at: string;
  title: string; status: string; hit: number;
}

interface FilterRaw {
  id: number; name: string; filter_json: string; version: number; created_at: string; updated_at: string;
}

function nowIso(): string { return new Date().toISOString(); }

function clampLimit(raw: unknown): number {
  return Math.min(200, Math.max(1, Number.isFinite(raw) ? Math.trunc(raw as number) : 50));
}

function clampOffset(raw: unknown): number {
  return Math.max(0, Number.isFinite(raw) ? Math.trunc(raw as number) : 0);
}

function requirePositiveInt(raw: unknown, field: string): number {
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  throw new AppError("INVALID_INPUT", field + " 必须是正整数");
}

function requireRule(raw: unknown): CleanupRule {
  if (typeof raw === "string" && RULE_VALUES.has(raw)) return raw as CleanupRule;
  throw new AppError("INVALID_INPUT", "rule 非法：" + String(raw));
}

function normalizeNote(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new AppError("INVALID_INPUT", "note 必须是字符串");
  if (raw.length > 500) throw new AppError("INVALID_INPUT", "note 最长 500 字符");
  return raw;
}

function normalizeFilterName(raw: unknown): string {
  if (typeof raw !== "string") throw new AppError("INVALID_INPUT", "name 必须是字符串");
  const name = raw.trim();
  if (name.length < 1 || name.length > 80) throw new AppError("INVALID_INPUT", "name 长度必须 1..80");
  return name;
}

function isUniqueViolation(e: unknown): boolean {
  return String((e as { code?: string })?.code ?? "").startsWith("SQLITE_CONSTRAINT_UNIQUE");
}

/** 单条规则的命中谓词（不套基础范围；missing_source 的 ? 是 localSourcePolicy）。 */
function ruleHitSql(rule: CleanupRule): string {
  return "CASE WHEN (" + RULE_PREDICATE[rule] + ") THEN 1 ELSE 0 END";
}

function ruleHitParams(rule: CleanupRule, policy: LocalSourcePolicy): unknown[] {
  return rule === "missing_source" ? [policy] : [];
}

/** 全部规则的命中 CASE（管理列表一次算完；missing_source 的 ? 是 localSourcePolicy）。 */
function allRulesHitSql(): string {
  return "CASE ci.rule" +
    " WHEN 'missing_cover' THEN (" + RULE_PREDICATE.missing_cover + ")" +
    " WHEN 'missing_source' THEN (" + RULE_PREDICATE.missing_source + ")" +
    " WHEN 'unlinked_model' THEN (" + RULE_PREDICATE.unlinked_model + ")" +
    " WHEN 'missing_file' THEN (" + RULE_PREDICATE.missing_file + ")" +
    " ELSE 0 END";
}

function toIgnoreRow(r: IgnoreRaw): CleanupIgnoreRow {
  return {
    itemId: Number(r.item_id),
    rule: r.rule as CleanupRule,
    note: r.note === null || r.note === undefined ? null : String(r.note),
    ignoredAt: String(r.ignored_at),
    resolved: Number(r.hit) !== 1,
    item: { id: Number(r.item_id), title: String(r.title), status: String(r.status) },
  };
}

function readIgnoreRow(db: Database.Database, itemId: number, rule: CleanupRule, policy: LocalSourcePolicy): CleanupIgnoreRow {
  const row = db.prepare(
    "SELECT ci.item_id AS item_id, ci.rule AS rule, ci.note AS note, ci.ignored_at AS ignored_at," +
    " i.title AS title, i.status AS status, " + ruleHitSql(rule) + " AS hit" +
    " FROM cleanup_ignores ci JOIN items i ON i.id = ci.item_id" +
    " WHERE ci.item_id = ? AND ci.rule = ?"
  ).get(...ruleHitParams(rule, policy), itemId, rule) as IgnoreRaw | undefined;
  if (!row) throw new AppError("NOT_FOUND", "忽略行不存在", 404);
  return toIgnoreRow(row);
}

/**
 * 忽略管理列表（纯读）：以 cleanup_ignores 为驱动，独立于待办派生。
 * 包含 archived/trashed 条目；resolved 按 (item, rule) 单条求值，不套基础范围/q/avatar/category。
 * 排序：ignored_at DESC, item_id ASC, rule ASC（rule 仅作稳定分页的 tiebreaker）。
 */
export function listCleanupIgnores(repo: Repo, q: CleanupIgnoreQuery): { total: number; ignores: CleanupIgnoreRow[] } {
  const policy = parseLocalSourcePolicy(q.localSourcePolicy);
  const resolved = pickEnum<"any" | "true" | "false">(q.resolved, RESOLVED_VALUES, "resolved", "any") ?? "any";
  const limit = clampLimit(q.limit);
  const offset = clampOffset(q.offset);
  const db = repo.connection;
  const inner = "SELECT ci.item_id AS item_id, ci.rule AS rule, ci.note AS note, ci.ignored_at AS ignored_at," +
    " i.title AS title, i.status AS status, " + allRulesHitSql() + " AS hit" +
    " FROM cleanup_ignores ci JOIN items i ON i.id = ci.item_id";
  const where = resolved === "any" ? "" : resolved === "true" ? " WHERE x.hit = 0" : " WHERE x.hit = 1";
  const total = Number((db.prepare("SELECT COUNT(*) AS n FROM (" + inner + ") x" + where).get(policy) as { n: number }).n);
  const rows = db.prepare("SELECT * FROM (" + inner + ") x" + where +
    " ORDER BY x.ignored_at DESC, x.item_id ASC, x.rule ASC LIMIT ? OFFSET ?")
    .all(policy, limit, offset) as IgnoreRaw[];
  return { total, ignores: rows.map(toIgnoreRow) };
}

/**
 * 幂等 upsert 忽略（只写 cleanup_ignores；不改 items/assets/item_images/item_avatars）。
 * 返回行的 resolved 按 include_local 口径求值（本函数无策略入参；管理列表会按请求策略重算）。
 */
export function upsertCleanupIgnore(repo: Repo, input: CleanupIgnoreInput): CleanupIgnoreRow {
  const itemId = requirePositiveInt(input.itemId, "itemId");
  const rule = requireRule(input.rule);
  const note = normalizeNote(input.note);
  const db = repo.connection;
  const exists = db.prepare("SELECT id FROM items WHERE id = ?").get(itemId);
  if (!exists) throw new AppError("NOT_FOUND", "条目不存在：" + itemId, 404);
  const before = db.prepare("SELECT item_id, rule, note, ignored_at FROM cleanup_ignores WHERE item_id = ? AND rule = ?").get(itemId, rule) ?? null;
  const at = nowIso();
  db.prepare("INSERT INTO cleanup_ignores(item_id, rule, note, ignored_at) VALUES (?,?,?,?)" +
    " ON CONFLICT(item_id, rule) DO UPDATE SET note = excluded.note, ignored_at = excluded.ignored_at")
    .run(itemId, rule, note, at);
  repo.logAudit("cleanup.ignore.upsert", "item", String(itemId), before, { rule, note, ignoredAt: at });
  return readIgnoreRow(db, itemId, rule, "include_local");
}

/** 恢复忽略：删行即恢复；幂等 0/1。 */
export function deleteCleanupIgnore(repo: Repo, itemId: number, rule: CleanupRule): { removed: 0 | 1 } {
  const id = requirePositiveInt(itemId, "itemId");
  const r = requireRule(rule);
  const db = repo.connection;
  const before = db.prepare("SELECT item_id, rule, note, ignored_at FROM cleanup_ignores WHERE item_id = ? AND rule = ?").get(id, r) ?? null;
  const info = db.prepare("DELETE FROM cleanup_ignores WHERE item_id = ? AND rule = ?").run(id, r);
  const removed: 0 | 1 = info.changes > 0 ? 1 : 0;
  if (removed === 1) repo.logAudit("cleanup.ignore.delete", "item", String(id), before, null);
  return { removed };
}

function toFilterRow(r: FilterRaw): CleanupFilterRow {
  return {
    id: Number(r.id),
    name: String(r.name),
    filter: JSON.parse(String(r.filter_json)) as CleanupFilter,
    version: Number(r.version),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function readFilterRow(db: Database.Database, id: number): CleanupFilterRow {
  const row = db.prepare("SELECT id, name, filter_json, version, created_at, updated_at FROM cleanup_saved_filters WHERE id = ?").get(id) as FilterRaw | undefined;
  if (!row) throw new AppError("NOT_FOUND", "筛选不存在：" + id, 404);
  return toFilterRow(row);
}

/** 保存筛选列表（纯读）。 */
export function listCleanupFilters(repo: Repo): { filters: CleanupFilterRow[] } {
  const rows = repo.connection.prepare(
    "SELECT id, name, filter_json, version, created_at, updated_at FROM cleanup_saved_filters ORDER BY name COLLATE NOCASE ASC, id ASC"
  ).all() as FilterRaw[];
  return { filters: rows.map(toFilterRow) };
}

/** 创建保存筛选：name 1..80（trim）、同名 409、filter 严格校验。 */
export function createCleanupFilter(repo: Repo, input: CleanupFilterCreateInput): CleanupFilterRow {
  const name = normalizeFilterName(input.name);
  const filter = validateCleanupFilter(input.filter);
  const at = nowIso();
  const db = repo.connection;
  let id: number;
  try {
    id = Number(db.prepare("INSERT INTO cleanup_saved_filters(name, filter_json, version, created_at, updated_at) VALUES (?,?,1,?,?)")
      .run(name, JSON.stringify(filter), at, at).lastInsertRowid);
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("CONFLICT", "筛选名称已存在：" + name, 409);
    throw e;
  }
  repo.logAudit("cleanup.filter.create", "cleanup_saved_filter", String(id), null, { name, filter });
  return readFilterRow(db, id);
}

/** 更新保存筛选：expectedVersion 必填；CAS 失败/同名 409；version 单调 +1。 */
export function patchCleanupFilter(repo: Repo, id: number, input: CleanupFilterPatchInput): CleanupFilterRow {
  const fid = requirePositiveInt(id, "id");
  const expected = requirePositiveInt(input.expectedVersion, "expectedVersion");
  const db = repo.connection;
  const existing = db.prepare("SELECT id, name, filter_json, version, created_at, updated_at FROM cleanup_saved_filters WHERE id = ?").get(fid) as FilterRaw | undefined;
  if (!existing) throw new AppError("NOT_FOUND", "筛选不存在：" + fid, 404);
  if (Number(existing.version) !== expected) {
    throw new AppError("CONFLICT", "筛选版本冲突：期望 " + expected + "，实际 " + existing.version, 409);
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.name !== undefined) { sets.push("name = ?"); params.push(normalizeFilterName(input.name)); }
  if (input.filter !== undefined) { sets.push("filter_json = ?"); params.push(JSON.stringify(validateCleanupFilter(input.filter))); }
  sets.push("version = version + 1", "updated_at = ?");
  params.push(nowIso(), fid, expected);
  let changes = 0;
  try {
    changes = db.prepare("UPDATE cleanup_saved_filters SET " + sets.join(", ") + " WHERE id = ? AND version = ?").run(...params).changes;
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("CONFLICT", "筛选名称已存在", 409);
    throw e;
  }
  if (changes === 0) throw new AppError("CONFLICT", "筛选版本冲突", 409);
  const after = readFilterRow(db, fid);
  repo.logAudit("cleanup.filter.update", "cleanup_saved_filter", String(fid),
    { name: existing.name, filter: JSON.parse(existing.filter_json), version: existing.version },
    { name: after.name, filter: after.filter, version: after.version });
  return after;
}

/** 删除保存筛选：幂等 0/1。 */
export function deleteCleanupFilter(repo: Repo, id: number): { deleted: 0 | 1 } {
  const fid = requirePositiveInt(id, "id");
  const db = repo.connection;
  const before = db.prepare("SELECT id, name, filter_json, version, created_at, updated_at FROM cleanup_saved_filters WHERE id = ?").get(fid) as FilterRaw | undefined;
  const info = db.prepare("DELETE FROM cleanup_saved_filters WHERE id = ?").run(fid);
  const deleted: 0 | 1 = info.changes > 0 ? 1 : 0;
  if (deleted === 1 && before) {
    repo.logAudit("cleanup.filter.delete", "cleanup_saved_filter", String(fid), { name: before.name, version: before.version }, null);
  }
  return { deleted };
}

const FILTER_KEYS: ReadonlySet<string> = new Set(["rule", "q", "avatarIds", "categoryIds", "ignored", "localSourcePolicy", "sort", "limit"]);

/**
 * 保存筛选严格校验：未知键拒绝；localSourcePolicy 必填（LOCAL_POLICY_REQUIRED）；
 * 没有 includeArchived/includeTrashed；q 只作为数据保存，永不拼 SQL。
 */
export function validateCleanupFilter(raw: unknown): CleanupFilter {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError("INVALID_INPUT", "filter 必须是对象");
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!FILTER_KEYS.has(key)) throw new AppError("INVALID_INPUT", "filter 未知字段：" + key);
  }
  const out: CleanupFilter = { localSourcePolicy: parseLocalSourcePolicy(obj.localSourcePolicy) };
  if (obj.rule !== undefined) out.rule = requireRule(obj.rule);
  if (obj.q !== undefined) {
    if (typeof obj.q !== "string") throw new AppError("INVALID_INPUT", "q 必须是字符串");
    const q = obj.q.trim();
    if (q.length > 200) throw new AppError("INVALID_INPUT", "q 最长 200 字符");
    out.q = q;
  }
  if (obj.avatarIds !== undefined) {
    if (!Array.isArray(obj.avatarIds)) throw new AppError("INVALID_INPUT", "avatarIds 必须是数组");
    if (obj.avatarIds.length > 50) throw new AppError("INVALID_INPUT", "avatarIds 最多 50 个");
    out.avatarIds = obj.avatarIds.map((v) => requirePositiveInt(v, "avatarIds[]"));
  }
  if (obj.categoryIds !== undefined) {
    if (!Array.isArray(obj.categoryIds)) throw new AppError("INVALID_INPUT", "categoryIds 必须是数组");
    if (obj.categoryIds.length > 50) throw new AppError("INVALID_INPUT", "categoryIds 最多 50 个");
    out.categoryIds = obj.categoryIds.map((v) => {
      if (typeof v !== "string") throw new AppError("INVALID_INPUT", "categoryIds[] 必须是字符串");
      const s = v.trim();
      if (!s) throw new AppError("INVALID_INPUT", "categoryIds[] 不能为空");
      return s;
    });
  }
  if (obj.ignored !== undefined) out.ignored = pickEnum<CleanupIgnoredMode>(obj.ignored, IGNORED_VALUES, "ignored");
  if (obj.sort !== undefined) out.sort = pickEnum<CleanupSort>(obj.sort, SORT_VALUES, "sort");
  if (obj.limit !== undefined) {
    if (typeof obj.limit !== "number" || !Number.isInteger(obj.limit) || obj.limit < 1 || obj.limit > 200) {
      throw new AppError("INVALID_INPUT", "limit 必须是 1..200 的整数");
    }
    out.limit = obj.limit;
  }
  return out;
}

/**
 * 合并忽略（同连接事务）：target 同 rule 胜出（INSERT OR IGNORE），随后删 source；
 * 审计与迁移同事务（C25：审计失败整体回滚）。返回被删除的 source 行数。
 * 同 id 直接拒绝，绝不删除自己的行。
 */
export function mergeCleanupIgnoresTx(db: Database.Database, sourceItemId: number, targetItemId: number): number {
  const source = requirePositiveInt(sourceItemId, "sourceItemId");
  const target = requirePositiveInt(targetItemId, "targetItemId");
  if (source === target) throw new AppError("INVALID_INPUT", "不能把忽略合并到同一条目", 400);
  const tx = db.transaction(() => {
    const src = db.prepare("SELECT id FROM items WHERE id = ?").get(source);
    const tgt = db.prepare("SELECT id FROM items WHERE id = ?").get(target);
    if (!src || !tgt) throw new AppError("NOT_FOUND", "条目不存在", 404);
    const before = db.prepare("SELECT item_id, rule, note, ignored_at FROM cleanup_ignores WHERE item_id = ? ORDER BY rule").all(source);
    const inserted = db.prepare("INSERT OR IGNORE INTO cleanup_ignores(item_id, rule, note, ignored_at)" +
      " SELECT ?, rule, note, ignored_at FROM cleanup_ignores WHERE item_id = ?").run(target, source).changes;
    const deleted = db.prepare("DELETE FROM cleanup_ignores WHERE item_id = ?").run(source).changes;
    db.prepare("INSERT INTO audit_log(at, actor, action, entity, entity_id, before_json, after_json) VALUES (?,?,?,?,?,?,?)")
      .run(nowIso(), "user", "merge.cleanup_ignores_moved", "item", String(target),
        JSON.stringify({ sourceItemId: source, ignores: before }),
        JSON.stringify({ inserted, deleted }));
    return deleted;
  });
  return tx();
}

