import { AppError } from "./contracts";
import { SEARCH_LEXICON, type SearchConcept } from "./search-lexicon";

export const SEARCH_FIELDS = ["avatar", "type", "author", "tag", "color", "style", "file", "shader", "id", "is", "has", "size", "site", "status", "format", "added", "updated", "supports"] as const;
export type SearchField = typeof SEARCH_FIELDS[number];
export const SEARCH_FACETS = ["avatar", "author", "tag", "color", "style", "site", "status", "format", "available", "size", "added", "updated", "favorite", "imported", "update"] as const;
export type SearchFacet = typeof SEARCH_FACETS[number];
export interface SearchSpan { start: number; end: number }
export interface SearchFilter extends SearchSpan { field: SearchField; value: string; exclude: boolean }
export interface SearchVariant { text: string; weight: number }
export interface SearchTerm extends SearchSpan {
  text: string;
  variants: SearchVariant[];
  concept?: SearchConcept;
  avatarIds?: number[];
  phrase?: boolean;
  optional?: boolean;
}
export interface SearchQuery {
  raw: string;
  terms: SearchTerm[];
  filters: SearchFilter[];
  exactTitle: string;
  exactId?: string;
  exactPath?: string;
}
export interface SearchVocabulary {
  concepts?: readonly SearchConcept[];
  avatars?: ReadonlyMap<string, readonly number[]>;
}

export function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\u30a1-\u30f6\u30fd-\u30fe]/gu,
    (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/\s+/gu, " ").trim();
}

export function normalizeSearchName(value: string): string {
  return normalizeSearch(value.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/[\p{P}\p{S}_]+/gu, " "));
}

const invalid = (message: string): never => { throw new AppError("INVALID_INPUT", message); };
const units: Record<string, number> = { b: 1, kb: 1000, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
function bytes(value: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?i?b)?$/iu.exec(value);
  if (!m || (m[2] && !units[m[2].toLowerCase()])) return invalid("文件大小格式无效，例如 size:>1GB 或 size:50MB..2GB");
  const result = Math.round(Number(m[1]) * (units[m[2]?.toLowerCase() ?? "b"] ?? 1));
  if (!Number.isSafeInteger(result)) return invalid("文件大小超出支持范围");
  return result;
}
export function parseSearchSize(value: string): { op: ">" | "<" | ">=" | "<=" | "=" | "between"; bytes: number; max?: number } {
  const range = value.split("..");
  if (range.length === 2) {
    const min = bytes(range[0]!);
    const max = bytes(range[1]!);
    if (min > max) return invalid("文件大小范围的下限不能大于上限");
    return { op: "between", bytes: min, max };
  }
  const m = /^(>=|<=|>|<|=)?(.+)$/u.exec(value);
  if (!m) return invalid("请输入文件大小");
  return { op: (m[1] ?? "=") as ">" | "<" | ">=" | "<=" | "=", bytes: bytes(m[2]!) };
}

interface Token extends SearchSpan { text: string; quoted: boolean }
function scanTokens(raw: string): Token[] {
  const tokens: Token[] = [];
  let text = "", quoted = false, inQuote = false, start = 0;
  for (let i = 0; i <= raw.length; i++) {
    const unit = raw[i];
    const char = unit?.normalize("NFKC");
    if (char === undefined || (!inQuote && /\s/u.test(char))) {
      if (inQuote) return invalid("搜索中的引号未闭合");
      if (text || quoted) tokens.push({ text, quoted, start, end: i });
      text = ""; quoted = false; start = i + 1;
    } else if (char === '"') {
      quoted = true;
      inQuote = !inQuote;
    } else if (char === "\\" && (raw[i + 1]?.normalize("NFKC") === '"' || /\s/u.test(raw[i + 1] ?? ""))) {
      text += raw[++i];
    } else text += unit;
  }
  return tokens;
}

const naturalFilters: readonly { pattern: RegExp; field: SearchField; value: (match: RegExpExecArray) => string }[] = [
  { pattern: /(?:已经|已)导入\s*unity(?:\s*的)?/iu, field: "is", value: () => "imported" },
  { pattern: /(?:超过|大于|小于)\s*\d+(?:\.\d+)?\s*[kmgt]?i?b(?:\s*的)?/iu, field: "size", value: (m) => (m[0].startsWith("小于") ? "<" : ">") + m[0].match(/\d+(?:\.\d+)?\s*[kmgt]?i?b/iu)![0] },
  { pattern: /(?:支持|适配)多个\s*avatars?(?:\s*的)?/iu, field: "supports", value: () => "multiple" },
  { pattern: /(?:没有分类|未分类)(?:\s*的)?/u, field: "type", value: () => "uncategorized" },
  { pattern: /最近(?:下载|入库)(?:但)?/u, field: "added", value: () => "30d" },
];

const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const tokenAlphabet = /[\p{Script=Latin}\p{N}]/u;
const acceptedFlags: Partial<Record<SearchField, readonly string[]>> = {
  is: ["favorite", "duplicate", "imported", "missing", "available"],
  has: ["update", "thumbnail"], supports: ["multiple"], status: ["active", "inbox", "archived", "trashed"],
  site: ["booth", "local", "other", "gumroad", "unity_asset_store", "itch"],
};

export function parseSearchQuery(raw: string, vocabulary: SearchVocabulary = {}): SearchQuery {
  if (raw.length > 512) return invalid("搜索词最多支持 512 个字符");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(raw)) return invalid("搜索中包含无效控制字符");
  const ast: SearchQuery = { raw, terms: [], filters: [], exactTitle: normalizeSearch(raw) };
  const input = raw;
  const canonical = input.normalize("NFKC").trim();
  const id = /^(?:https?:\/\/(?:[\w-]+\.)?booth\.pm\/(?:[a-z-]+\/)?items\/)?(\d{5,9})(?:[?#].*)?$/iu.exec(canonical);
  if (id) { ast.exactId = id[1]; return ast; }
  if (/^(?:"?(?:[a-z]:[\\/]|\\\\|\/))/iu.test(canonical)) {
    scanTokens(input);
    ast.exactPath = input.trim().replace(/^["＂]|["＂]$/gu, "");
    return ast;
  }
  const conceptMap = new Map<string, SearchConcept>();
  for (const concept of [...SEARCH_LEXICON, ...(vocabulary.concepts ?? [])]) {
    for (const word of concept.words) conceptMap.set(normalizeSearch(word), concept);
  }
  const avatars = vocabulary.avatars ?? new Map();
  const segmented = [...new Set([...conceptMap.keys(), ...avatars.keys()])].filter((s) => cjk.test(s)).sort((a, b) => b.length - a.length);
  const addTerm = (token: Token, segment = token.text) => {
    const text = normalizeSearch(segment);
    if (!text) return;
    const concept = token.quoted ? undefined : conceptMap.get(text);
    const avatarIds = token.quoted ? undefined : avatars.get(text);
    const variants = new Map([[text, 1]]);
    const split = normalizeSearchName(segment);
    if (split && split !== text) variants.set(split, 0.94);
    for (const word of concept?.words ?? []) {
      const normalized = normalizeSearch(word);
      if (normalized !== text) variants.set(normalized, 0.76);
    }
    for (const word of concept?.related ?? []) {
      const normalized = normalizeSearch(word);
      if (!variants.has(normalized)) variants.set(normalized, 0.43);
    }
    ast.terms.push({ text, variants: [...variants].map(([text, weight]) => ({ text, weight })), start: token.start, end: token.end,
      concept, avatarIds: avatarIds ? [...avatarIds] : undefined, phrase: token.quoted, optional: concept?.generic });
  };
  const tokens = scanTokens(input);
  for (let position = 0; position < tokens.length; position++) {
    const token = tokens[position]!;
    const text = normalizeSearch(token.text);
    const advanced = /^(-?)([a-z][a-z0-9_-]*):(.*)$/u.exec(text);
    if (advanced && !/^https?:\/\//u.test(text) && !/^[a-z]:[\\/]/u.test(text)) {
      const field = advanced[2] as SearchField;
      const value = advanced[3]!;
      if (!SEARCH_FIELDS.includes(field)) return invalid("未知搜索条件「" + field + "」");
      if (!value) return invalid("请为「" + field + "」填写搜索值");
      if (field === "size") parseSearchSize(value);
      if (field === "id" && !/^\d{5,9}$/u.test(value)) return invalid("BOOTH 商品号应为 5–9 位数字");
      if (field === "format" && !/^\.?[a-z0-9]{1,20}$/u.test(value)) return invalid("文件格式应为扩展名，例如 format:fbx");
      if (acceptedFlags[field] && !acceptedFlags[field]!.includes(value)) return invalid("「" + field + "」的可用值为 " + acceptedFlags[field]!.join("、"));
      if ((field === "added" || field === "updated") && !/^[1-9]\d{0,3}d$/u.test(value)
        && (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(value))
          || new Date(value).toISOString().slice(0, 10) !== value)) {
        return invalid("日期条件示例为 added:7d 或 updated:2026-01-01");
      }
      ast.filters.push({ start: token.start, end: token.end, field, value, exclude: advanced[1] === "-" });
      continue;
    }
    if (input[token.start]?.normalize("NFKC") === "@" && /^@.+/u.test(text)) {
      ast.filters.push({ start: token.start, end: token.end, field: "avatar", value: text.slice(1), exclude: false });
      continue;
    }
    if (!token.quoted) {
      for (let length = Math.min(4, tokens.length - position); length > 1; length--) {
        const group = tokens.slice(position, position + length);
        if (group.some((part) => part.quoted)) continue;
        const phrase = group.map((part) => part.text).join(" ");
        if (!conceptMap.has(normalizeSearch(phrase)) && !avatars.has(normalizeSearch(phrase))) continue;
        addTerm({ text: phrase, start: token.start, end: group.at(-1)!.end, quoted: false });
        position += length - 1;
        break;
      }
      if (tokens[position] !== token) continue;
    }
    addTerm(token);
  }

  // Read natural clauses only in unquoted text; explicit syntax always wins.
  for (const rule of naturalFilters) {
    const match = rule.pattern.exec(input);
    if (!match) continue;
    const start = match.index, end = start + match[0].length;
    if (ast.filters.some((f) => start < f.end && end > f.start) || ast.terms.some((t) => t.phrase && start < t.end && end > t.start)) continue;
    ast.filters.push({ field: rule.field, value: rule.value(match), exclude: false, start, end });
    const original = ast.terms.splice(0);
    for (const t of original) {
      if (t.end <= start || t.start >= end) { ast.terms.push(t); continue; }
      if (t.start < start) addTerm({ text: input.slice(t.start, start), start: t.start, end: start, quoted: false });
      if (t.end > end) addTerm({ text: input.slice(end, t.end), start: end, end: t.end, quoted: false });
    }
  }

  for (const t of ast.terms.splice(0)) {
    const negative = /^(?:不要|排除)(.+)$/u.exec(t.text);
    const excludedType = negative && conceptMap.get(negative[1]!)?.type;
    if (excludedType && !t.phrase) {
      ast.filters.push({ field: "type", value: excludedType, exclude: true, start: t.start, end: t.end });
      continue;
    }
    if (t.phrase || !cjk.test(t.text) || t.concept || t.avatarIds || t.text.length !== t.end - t.start
      || /[.\\/]/u.test(t.text)) { ast.terms.push(t); continue; }
    let cursor = 0, from = 0;
    while (cursor < t.text.length) {
      const word = segmented.find((s) => t.text.startsWith(s, cursor)
        && (!tokenAlphabet.test(s[0]!) || !tokenAlphabet.test(t.text[cursor - 1] ?? ""))
        && (!tokenAlphabet.test(s.at(-1)!) || !tokenAlphabet.test(t.text[cursor + s.length] ?? "")));
      if (!word) { cursor++; continue; }
      if (from < cursor) addTerm({ text: t.text.slice(from, cursor), quoted: false, start: t.start + from, end: t.start + cursor });
      addTerm({ text: word, quoted: false, start: t.start + cursor, end: t.start + cursor + word.length });
      cursor += word.length;
      from = cursor;
    }
    if (from < t.text.length) addTerm({ text: t.text.slice(from), quoted: false, start: t.start + from, end: t.end });
  }
  if (ast.filters.some((f) => naturalFilters.some((r) => r.field === f.field))) {
    for (const t of ast.terms) if (/^(?:的|素材|但)$/u.test(t.text)) t.optional = true;
  }
  if (ast.terms.some((term) => !term.optional && !term.concept?.field)) {
    for (const term of ast.terms) if (term.concept?.field) term.optional = true;
  }
  ast.terms = [...new Map(ast.terms.map((t) => [t.text, t])).values()];
  if (ast.filters.length > 20 || ast.terms.length > 16) return invalid("请缩短查询，最多支持 16 个关键词和 20 个筛选条件");
  return ast;
}
