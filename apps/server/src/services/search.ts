import type Database from "better-sqlite3";
import { AppError } from "../../../../packages/core/src/contracts";
import { normalizePath } from "../../../../packages/core/src/pathnorm";
import { AVATAR_SEARCH_NAMES, SEARCH_LEXICON, type SearchConcept } from "../../../../packages/core/src/search-lexicon";
import { normalizeSearch, parseSearchQuery, parseSearchSize, type SearchField, type SearchFilter, type SearchQuery, type SearchTerm } from "../../../../packages/core/src/search-query";
import { searchToken, typoKeys } from "./search-index";

export const SEARCH_CANDIDATES_PER_LANE = 12_000;
type Param = string | number;
interface Clause { sql: string; values: Param[] }
interface SearchReference {
  avatars: Map<string, number[]>;
  categories: Map<string, string[]>;
  concepts: SearchConcept[];
}
export interface SearchPlan {
  query: SearchQuery;
  clauses: Clause[];
  prefix: string;
  join: string;
  values: Param[];
  ranked: boolean;
  exactTitleOnly?: boolean;
  debug?: boolean;
}

function readReference(db: Database.Database): SearchReference {
  const avatars = new Map<string, number[]>();
  const categories = new Map<string, string[]>();
  for (const row of db.prepare("SELECT id, name FROM avatars UNION ALL SELECT avatar_id,alias FROM avatar_aliases").all() as { id: number; name: string }[]) {
    const key = normalizeSearch(row.name);
    avatars.set(key, [...new Set([...(avatars.get(key) ?? []), row.id])]);
  }
  for (const [name, aliases] of Object.entries(AVATAR_SEARCH_NAMES)) {
    const ids = avatars.get(name);
    if (!ids) continue;
    for (const alias of aliases) {
      const key = normalizeSearch(alias);
      if (!avatars.has(key)) avatars.set(key, ids);
    }
  }
  for (const row of db.prepare("SELECT id,name FROM categories").all() as { id: string; name: string }[]) {
    categories.set(normalizeSearch(row.id), [row.id]);
    const key = normalizeSearch(row.name);
    categories.set(key, [...new Set([...(categories.get(key) ?? []), row.id])]);
  }
  const concepts = customSearchConcepts(db);
  return { avatars, categories, concepts };
}

function customSearchConcepts(db: Database.Database): SearchConcept[] {
  return (db.prepare("SELECT concept_json FROM search_lexicon ORDER BY id").pluck().all() as string[])
    .map((json) => JSON.parse(json) as SearchConcept);
}

export function searchFacetWords(db: Database.Database, field: "color" | "style"): string {
  return JSON.stringify([...SEARCH_LEXICON, ...customSearchConcepts(db)]
    .filter((entry) => entry.field === field)
    .flatMap((entry) => entry.words.map((word) => [word.normalize("NFKC").toLowerCase(), entry.id])));
}

const phrase = (input: string) => '"' + input.replace(/"/gu, '""') + '"';
const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(",");
const escapeLike = (input: string) => input.replace(/[\\%_]/gu, "\\$&");
const checkLinked = (subquery: string) => "EXISTS (" + subquery + ")";
const categoryMatch = (ids: string[]): Clause => {
  const categorized = ids.filter((id) => id !== "uncategorized");
  const ph = placeholders(categorized);
  const predicates = [];
  if (categorized.length) predicates.push("i.cat_id IN (" + ph + ") OR i.cat_sub_id IN (" + ph + ")");
  if (ids.includes("uncategorized")) predicates.push("i.cat_id IS NULL OR i.cat_id='uncategorized'");
  return { sql: predicates.length ? "(" + predicates.join(" OR ") + ")" : "0", values: [...categorized, ...categorized] };
};

const entrySources = [
  { label: "file", from: "assets a", path: "a.path", extra: "" },
  { label: "archive", from: "assets a JOIN archive_entries p ON p.asset_id=a.id", path: "p.entry_path", extra: " AND p.is_dir=0" },
  { label: "unitypackage", from: "assets a JOIN unitypackage_assets p ON p.asset_id=a.id", path: "p.asset_path", extra: "" },
  { label: "unitypackage", from: "assets a JOIN asset_units p ON p.asset_id=a.id", path: "p.rel_path", extra: "" },
] as const;

function fileMatch(value: string, shader: boolean): Clause {
  const path = value.replace(/\\/gu, "/");
  const wildcard = path.includes("*") || path.includes("?");
  const pattern = escapeLike(path).replace(/\*/gu, "%").replace(/\?/gu, "_");
  const escaped = wildcard ? pattern : "%" + pattern + "%";
  const evidence = entrySources.map((source) => checkLinked("SELECT 1 FROM " + source.from
    + " WHERE a.item_id=i.id AND a.status<>'trashed'" + source.extra + " AND REPLACE(" + source.path
    + ",char(92),'/') LIKE ? ESCAPE char(92)" + (shader ? " AND lower(" + source.path + ") LIKE '%.shader'" : "")));
  const values = entrySources.map(() => escaped);
  if (shader) {
    evidence.push(checkLinked("SELECT 1 FROM assets a JOIN asset_units u ON u.asset_id=a.id JOIN unit_relations r ON r.from_unit_id=u.id "
      + "JOIN asset_units d ON d.id=r.to_unit_id JOIN assets da ON da.id=d.asset_id WHERE a.item_id=i.id AND a.status<>'trashed' "
      + "AND da.status<>'trashed' AND r.type IN ('requires','dependency','depends_on') AND lower(d.rel_path) LIKE '%.shader' AND d.rel_path LIKE ? ESCAPE char(92)"));
    values.push(escaped);
  }
  const exact = "(" + evidence.join(" OR ") + ")";
  if (shader) return { sql: exact, values };
  const fallback = "i.id IN (SELECT item_id FROM search_dirty WHERE refresh_only=0 UNION SELECT item_id FROM search_documents WHERE path_limited=1)";
  const extension = /^\*\.([a-z0-9]{1,20})$/u.exec(path);
  if (extension) {
    return { sql: "(i.id IN (SELECT rowid FROM search_terms_fts WHERE search_terms_fts MATCH ? AND "
      + derivedFresh + "search_terms_fts.rowid)) OR (" + fallback + " AND " + exact + "))", values: ["formats:" + searchToken(extension[1]!), ...values] };
  }
  const longest = path.split(/[*?]/u).sort((a, b) => b.length - a.length)[0] ?? "";
  if (Array.from(longest).length < 3) return { sql: exact, values };
  return { sql: "((" + fallback + " OR i.id IN (SELECT rowid FROM search_text_fts WHERE search_text_fts MATCH ?)) AND "
    + exact + ")", values: ["{files contents}: " + phrase(longest), ...values] };
}

function compileFilter(filter: SearchFilter, ref: SearchReference): Clause {
  const { field, value } = filter;
  const concept = [...ref.concepts, ...SEARCH_LEXICON].find((entry) => [entry.id, ...entry.words].some((w) => normalizeSearch(w) === value));
  const simple = (sql: string, ...values: Param[]): Clause => ({ sql, values });
  switch (field) {
    case "id": return simple("(i.source_site='booth' AND i.source_item_id=?)", value);
    case "type": return categoryMatch(concept?.type ? [concept.type] : ref.categories.get(value) ?? []);
    case "avatar": {
      const ids = ref.avatars.get(value) ?? [];
      return ids.length ? simple(checkLinked("SELECT 1 FROM item_avatars a WHERE a.item_id=i.id AND a.match<>'exclude' AND a.avatar_id IN (" + placeholders(ids) + ")"), ...ids)
        : simple("0");
    }
    case "author": return simple("(i.author LIKE ? ESCAPE char(92) OR i.shop_name LIKE ? ESCAPE char(92))", "%" + escapeLike(value) + "%", "%" + escapeLike(value) + "%");
    case "tag": case "color": case "style": {
      const words = field === "tag" ? [value] : (concept?.field === field ? [value, ...concept.words.map((word) => word.normalize("NFKC").toLowerCase())] : [value]);
      return simple(checkLinked("SELECT 1 FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=i.id AND t.name COLLATE NOCASE IN ("
        + placeholders(words) + ")"), ...words);
    }
    case "file": return fileMatch(value, false);
    case "shader": return fileMatch(value, true);
    case "format": return fileMatch("*." + value.replace(/^\./u, ""), false);
    case "site": return simple("i.source_site=?", value);
    case "status": return simple("i.status=?", value);
    case "supports": return simple("(SELECT COUNT(*) FROM item_avatars a WHERE a.item_id=i.id AND a.match<>'exclude')>1");
    case "size": {
      const { op, bytes, max } = parseSearchSize(value);
      const total = "(SELECT COALESCE(SUM(a.size),0) FROM assets a WHERE a.item_id=i.id AND a.status<>'trashed')";
      return op === "between" ? simple(total + " BETWEEN ? AND ?", bytes, max!) : simple(total + " " + op + " ?", bytes);
    }
    case "added": case "updated": {
      const iso = value.endsWith("d") ? new Date(Date.now() - Number(value.slice(0, -1)) * 86400000).toISOString() : value;
      return simple("i." + (field === "added" ? "created_at" : "updated_at") + ">=?", iso);
    }
    case "has": return value === "update" ? simple(checkLinked("SELECT 1 FROM updates u WHERE u.item_id=i.id AND u.applied=0"))
      : simple(checkLinked("SELECT 1 FROM item_images m WHERE m.item_id=i.id AND (m.thumb_path IS NOT NULL OR m.file_path IS NOT NULL)"));
    case "is": {
      if (value === "favorite") return simple("i.favorite=1");
      if (value === "imported") return simple(checkLinked("SELECT 1 FROM project_imports p WHERE p.item_id=i.id"));
      if (value === "missing" || value === "available") return simple(checkLinked("SELECT 1 FROM assets a WHERE a.item_id=i.id AND a.status=?"), value === "missing" ? "missing" : "present");
      return simple(checkLinked("SELECT 1 FROM assets a JOIN asset_signatures s ON s.asset_id=a.id "
        + "JOIN asset_signatures d ON d.file_sha=s.file_sha AND d.asset_id<>s.asset_id "
        + "JOIN assets b ON b.id=d.asset_id WHERE a.item_id=i.id AND a.status<>'trashed' AND b.status<>'trashed' AND s.file_sha IS NOT NULL"));
    }
  }
}

function filterClauses(query: SearchQuery, ref: SearchReference): Clause[] {
  const positive = new Map<string, Clause[]>();
  const result: Clause[] = [];
  const independent = new Set(["is", "has", "size", "added", "updated", "supports"]);
  for (const filter of query.filters) {
    const clause = compileFilter(filter, ref);
    if (filter.exclude) { result.push({ sql: "NOT COALESCE((" + clause.sql + "),0)", values: clause.values }); continue; }
    if (independent.has(filter.field)) { result.push(clause); continue; }
    positive.set(filter.field, [...(positive.get(filter.field) ?? []), clause]);
  }
  for (const clauses of positive.values()) {
    result.push({ sql: "(" + clauses.map((c) => c.sql).join(" OR ") + ")", values: clauses.flatMap((c) => c.values) });
  }
  if (query.exactId) result.push({ sql: "i.source_site='booth' AND i.source_item_id=?", values: [query.exactId] });
  if (query.exactPath) result.push({
    sql: "i.id IN (SELECT item_id FROM assets WHERE status<>'trashed' AND path_norm=?)",
    values: [normalizePath(query.exactPath)],
  });
  return result;
}

const scopes = { title: 77, tags: 72, author: 59, description: 35, files: 49, contents: 27 } as const;
const derivedFresh = "NOT EXISTS (SELECT 1 FROM search_dirty d WHERE d.refresh_only=0 AND d.item_id=";
const inScope = (field: string, patterns: string[]) => field + " : (" + patterns.join(" OR ") + ")";

export type SearchOmit = SearchField | "is.availability" | "is.favorite" | "is.imported" | "has.update";

function buildSearch(db: Database.Database, raw: string, omit?: SearchOmit, debug = false): SearchPlan {
  const ref = readReference(db);
  const query = parseSearchQuery(raw, { avatars: ref.avatars, concepts: ref.concepts });
  if (omit) {
    const [field, flag] = omit.split(".");
    const values = flag === "availability" ? ["available", "missing"] : [flag];
    query.filters = query.filters.filter((filter) => filter.field !== field || (flag && !values.includes(filter.value)));
  }
  const clauses = filterClauses(query, ref);
  const ranked = query.terms.length > 0 && (query.filters.length === 0 || query.terms.some((term) => !term.optional));
  const plan: SearchPlan = { query, clauses, prefix: "", join: "", values: [], ranked, debug };
  if (!plan.ranked) return plan;
  if (!query.filters.length && (query.terms.length >= 3 || query.terms.some((t) => t.phrase))) {
    const exact = "SELECT item_id id FROM search_documents WHERE title_key=? AND " + derivedFresh + "search_documents.item_id)"
      + " UNION SELECT id FROM items WHERE title=? COLLATE NOCASE";
    const values = [query.exactTitle.replace(/^"|"$/gu, ""), raw.trim().replace(/^"|"$/gu, "")];
    if (db.prepare("SELECT 1 FROM (" + exact + ") LIMIT 1").get(...values)) {
      clauses.push({ sql: "i.id IN (" + exact + ")", values });
      return { ...plan, ranked: false, exactTitleOnly: true };
    }
  }
  const selects: string[] = [];
  const add = (term: number, score: number, reason: string, selection: string, ...values: Param[]) => {
    selects.push("SELECT id AS item_id," + term + " AS term," + score + " AS points,'" + reason + "' AS reason FROM (" + selection + " LIMIT " + SEARCH_CANDIDATES_PER_LANE + ")");
    plan.values.push(...values);
  };
  const indexMatch = (table: "search_text_fts" | "search_terms_fts") =>
    "SELECT rowid AS id FROM " + table + " WHERE " + table + " MATCH ? AND " + derivedFresh + table + ".rowid)";

  const addTerm = (term: SearchTerm, ordinal: number) => {
    const direct = term.variants.filter((v) => v.weight >= 0.93);
    const expansions = term.variants.filter((v) => v.weight < 0.93);
    for (const [scope, score] of Object.entries(scopes)) {
      for (const [variants, weight, suffix] of [[direct, 1, ""], [expansions.filter((v) => v.weight >= 0.6), 0.76, ":expanded"],
        [expansions.filter((v) => v.weight < 0.6), 0.43, ":expanded"]] as const) {
        const long = variants.filter((v) => Array.from(v.text).length >= 3).map((v) => phrase(v.text));
        const short = variants.filter((v) => Array.from(v.text).length < 3 && /[\p{L}\p{N}]/u.test(v.text)).map((v) => searchToken(v.text));
        if (long.length) add(ordinal, Math.round(score * weight), scope + suffix, indexMatch("search_text_fts"), inScope(scope, long));
        if (short.length) add(ordinal, Math.round(score * weight), scope + suffix, indexMatch("search_terms_fts"), inScope(scope, short));
      }
    }
    const tagNames = term.variants.filter((v) => v.weight >= 0.76).map((v) => v.text);
    if (tagNames.length) add(ordinal, 88, "tag:manual", "SELECT it.item_id id FROM item_tags it JOIN tags t ON t.id=it.tag_id "
      + "WHERE it.source='manual' AND t.name COLLATE NOCASE IN (" + placeholders(tagNames) + ")", ...tagNames);
    if (term.avatarIds?.length) {
      add(ordinal, 95, "avatar:confirmed", "SELECT DISTINCT item_id id FROM item_avatars WHERE source IN ('manual','confirmed') AND match<>'exclude' AND avatar_id IN (" + placeholders(term.avatarIds) + ")", ...term.avatarIds);
      add(ordinal, 81, "avatar:possible", "SELECT DISTINCT item_id id FROM item_avatars WHERE match<>'exclude' AND avatar_id IN (" + placeholders(term.avatarIds) + ")", ...term.avatarIds);
    }
    if (term.concept?.type) {
      const type = term.concept.type;
      add(ordinal, 85, "type", "SELECT id FROM items WHERE cat_id=? OR cat_sub_id=?", type, type);
    }
    const legacy = term.variants.filter((v) => Array.from(v.text).length >= 3).map((v) => phrase(v.text));
    if (legacy.length) add(ordinal, 33, "legacy", "SELECT rowid id FROM items_fts WHERE items_fts MATCH ? AND "
      + "NOT EXISTS (SELECT 1 FROM search_documents d WHERE d.item_id=items_fts.rowid AND " + derivedFresh + "d.item_id))", legacy.join(" OR "));
    const shortPatterns = term.variants.filter((v) => Array.from(v.text).length < 3 && /[\p{L}\p{N}]/u.test(v.text)).map((v) => "%" + escapeLike(v.text) + "%");
    if (shortPatterns.length) {
      const shortOptions = shortPatterns.map(() => "(i.title LIKE ? ESCAPE char(92) OR COALESCE(i.description,'') LIKE ? ESCAPE char(92) "
        + "OR COALESCE(i.author,'') LIKE ? ESCAPE char(92) OR COALESCE(i.shop_name,'') LIKE ? ESCAPE char(92) OR COALESCE(i.notes,'') LIKE ? ESCAPE char(92) "
        + "OR EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=i.id AND t.name LIKE ? ESCAPE char(92)))");
      add(ordinal, 37, "legacy", "SELECT i.id FROM search_dirty d JOIN items i ON i.id=d.item_id WHERE d.refresh_only=0 AND (" + shortOptions.join(" OR ") + ")",
      ...shortPatterns.flatMap((p) => Array<string>(6).fill(p)));
    }
    if (!term.phrase && !term.avatarIds && !term.concept) {
      const variants = typoKeys(term.text);
      if (variants.length) add(ordinal, 13, "typo", indexMatch("search_terms_fts"), inScope("typos", variants));
    }
  };
  query.terms.forEach(addTerm);
  const exact = query.filters.length === 0 ? query.exactTitle : "";
  if (exact) {
    add(-1, 1600, "exact-title", "SELECT item_id id FROM search_documents WHERE title_key=? AND " + derivedFresh + "search_documents.item_id)", exact);
    add(-1, 1600, "exact-title", "SELECT id FROM items WHERE title=? COLLATE NOCASE", raw.trim().replace(/^"|"$/gu, ""));
  }
  if (!selects.length) { plan.ranked = false; clauses.push({ sql: "0", values: [] }); return plan; }
  const required = query.terms.flatMap((t, n) => t.optional ? [] : [n]);
  const countRequired = required.length ? "sum(CASE WHEN t.term IN (" + required.join(",") + ") THEN 1 ELSE 0 END)>=" + required.length : "count(*)>0";
  plan.prefix = "WITH search_hits AS (" + selects.join(" UNION ALL ") + "),"
    + "search_best AS (SELECT item_id,term,max(points) points,substr(max(printf('%04d:%s',points,reason)),6) reason"
    + (debug ? ",group_concat(DISTINCT reason) channels" : "") + " FROM search_hits GROUP BY item_id,term),"
    + "search_rank AS (SELECT t.item_id,sum(t.points) score,group_concat(t.reason) reasons"
    + (debug ? ",json_group_array(json_object('term',t.term,'score',t.points,'reason',t.reason,'channels',t.channels)) details" : "")
    + " FROM search_best t GROUP BY t.item_id HAVING "
    + "max(CASE WHEN t.term=-1 THEN 1 ELSE 0 END)=1 OR " + countRequired + ") ";
  plan.join = " JOIN search_rank sr ON sr.item_id=i.id";
  return plan;
}

const plans = new WeakMap<Database.Database, { rev: string; entries: Map<string, SearchPlan> }>();
export function compileSearch(db: Database.Database, raw: string, omit?: SearchOmit, debug = false): SearchPlan {
  const revision = [db.pragma("data_version", { simple: true }), db.prepare("SELECT total_changes()").pluck().get(),
    Math.floor(Date.now() / 60_000)].join(":");
  let cache = plans.get(db);
  if (!cache || cache.rev !== revision) {
    cache = { rev: revision, entries: new Map() };
    plans.set(db, cache);
  }
  const key = (debug ? "debug:" : "") + (omit ?? "") + ":" + raw;
  const previous = cache.entries.get(key);
  if (previous) {
    cache.entries.delete(key);
    cache.entries.set(key, previous);
    return previous;
  }
  const plan = buildSearch(db, raw, omit, debug);
  if (cache.entries.size >= 96) cache.entries.delete(cache.entries.keys().next().value!);
  cache.entries.set(key, plan);
  return plan;
}

export function searchSuggestions(db: Database.Database, input: string): { query: string; label: string }[] {
  const raw = input.trimStart().slice(0, 512);
  const fragment = raw.match(/\S*$/u)?.[0] ?? "";
  const prefix = raw.slice(0, raw.length - fragment.length);
  const key = normalizeSearch(fragment);
  if (!key) return [];
  const ref = readReference(db);
  const out = new Map<string, string>();
  const add = (query: string, label: string) => { if (query !== raw.trim() && !out.has(query)) out.set(query, label); };
  const avatarPrefix = key.replace(/^(?:avatar:|@)/u, "");
  if (avatarPrefix) for (const name of ref.avatars.keys()) {
    if (name.startsWith(avatarPrefix) && out.size < 3) add(prefix + "avatar:" + (name.includes(" ") ? '"' + name + '"' : name), "Avatar · " + name);
  }
  for (const concept of [...ref.concepts, ...SEARCH_LEXICON]) {
    if (out.size >= 6) break;
    const words = concept.words.map(normalizeSearch);
    if (words.some((word) => word.startsWith(key))) {
      const value = concept.type ? "type:" + concept.type : concept.label;
      add(prefix + value, concept.label);
    }
  }
  if (out.size < 8 && /^[a-z][a-z0-9-]{2,23}$/u.test(key)) {
    for (const row of db.prepare("SELECT title FROM items WHERE title LIKE ? ESCAPE char(92) AND status<>'trashed' ORDER BY title COLLATE NOCASE LIMIT 4")
      .all(escapeLike(key) + "%") as { title: string }[]) {
      add(prefix + '"' + row.title.replace(/"/gu, '\\"') + '"', row.title);
    }
    const typos = typoKeys(key);
    if (out.size < 8 && typos.length) for (const row of db.prepare("SELECT i.title FROM search_terms_fts JOIN items i ON i.id=search_terms_fts.rowid "
      + "WHERE search_terms_fts MATCH ? AND i.status<>'trashed' LIMIT 4").all(inScope("typos", typos)) as { title: string }[]) {
      add(prefix + '"' + row.title.replace(/"/gu, '\\"') + '"', "可能相关 · " + row.title);
    }
  }
  return [...out].slice(0, 8).map(([query, label]) => ({ query, label }));
}

export function searchPathPreviews(db: Database.Database, ids: number[], query: SearchQuery): Map<number, { path: string; kind: string }[]> {
  const file = query.filters.find((f) => (f.field === "file" || f.field === "shader" || f.field === "format") && !f.exclude);
  const words = file ? [file.field === "format" ? "*." + file.value.replace(/^\./u, "") : file.value]
    : query.exactPath ? [query.exactPath] : query.terms.flatMap((t) => t.variants.slice(0, 1).map((v) => v.text));
  if (!ids.length || !words.length) return new Map();
  const matches = words.slice(0, 6).map((word) => {
    const path = word.replace(/\\/gu, "/");
    const pattern = escapeLike(path).replace(/\*/gu, "%").replace(/\?/gu, "_");
    return /[*?]/u.test(path) ? pattern : "%" + pattern + "%";
  });
  const rows = db.prepare("SELECT page.value id, (SELECT json_group_array(json_object('path',path,'kind',kind)) FROM ("
    + entrySources.map((source) => "SELECT " + source.path + " path,'" + source.label + "' kind FROM " + source.from
      + " WHERE a.item_id=page.value AND a.status<>'trashed'" + source.extra
      + (file?.field === "shader" ? " AND lower(" + source.path + ") LIKE '%.shader'" : "")
      + " AND (" + matches.map(() => "REPLACE(" + source.path + ",char(92),'/') LIKE ? ESCAPE char(92)").join(" OR ") + ")")
      .join(" UNION ALL ")
    + (file?.field === "shader" ? " UNION ALL SELECT d.rel_path,CASE WHEN r.confirmed=1 THEN 'verified-dependency' ELSE 'inferred-dependency' END FROM assets a"
      + " JOIN asset_units u ON u.asset_id=a.id JOIN unit_relations r ON r.from_unit_id=u.id JOIN asset_units d ON d.id=r.to_unit_id"
      + " JOIN assets da ON da.id=d.asset_id WHERE a.item_id=page.value AND a.status<>'trashed' AND da.status<>'trashed'"
      + " AND r.type IN ('requires','dependency','depends_on') AND lower(d.rel_path) LIKE '%.shader' AND d.rel_path LIKE ? ESCAPE char(92)" : "")
    + " LIMIT 3)) paths FROM json_each(?) page").all(...entrySources.flatMap(() => matches),
      ...(file?.field === "shader" ? [matches[0]!] : []), JSON.stringify(ids)) as { id: number; paths: string }[];
  return new Map(rows.map((r) => [r.id, JSON.parse(r.paths)]));
}

export function saveSearchConcept(db: Database.Database, concept: SearchConcept) {
  if (!concept || typeof concept.id !== "string" || !/^[a-z0-9-]{1,64}$/u.test(concept.id) || typeof concept.label !== "string" || !concept.label.trim()
    || !Array.isArray(concept.words) || concept.words.length < 2 || concept.words.length > 24
    || concept.words.some((word) => typeof word !== "string" || !word.trim() || word.length > 64)
    || (concept.related !== undefined && (!Array.isArray(concept.related) || concept.related.length > 24
      || concept.related.some((word) => typeof word !== "string" || !word.trim() || word.length > 64)))) {
    throw new AppError("INVALID_INPUT", "词库条目需要简短 ID、显示名称和 2–24 个词");
  }
  db.prepare("INSERT INTO search_lexicon(id,concept_json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET concept_json=excluded.concept_json")
    .run(concept.id, JSON.stringify({ id: concept.id, label: concept.label, words: concept.words, related: concept.related,
      type: typeof concept.type === "string" ? concept.type : undefined, field: concept.field, generic: concept.generic === true }));
}
