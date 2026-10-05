/**
 * related.ts — 「疑似同商品」识别（纯函数，core 所有）
 *
 * 只回答一个问题：两个条目是不是**同一商品**的分别打包（模型包 / 材质包 / DLC / 本体）？
 * 与 dedupe.ts 的"同内容"是两回事：这里只比标题 / 标签 / 包内一级条目名里的**产品名片段**，
 * 不读字节、不算哈希，也绝不改任何数据（归组/合并由 UI 决定）。
 *
 * 口径（冻结）：
 *   1) 归一化：NFKC + 小写；emoji / 符号 / 标点 / 空白一律当分隔符（保留中日文与字母数字），
 *      中日文与 ASCII 字母数字的交界处再切一刀（"真実の穴material" → "真実の穴" + "material"）；
 *   2) 独立片段命中噪音词表 → 丢弃（材质 / 模型 / readme / 版本号等，见 NOISE）；
 *   3) 候选 key = 片段归一化后的形态（长度 >= 2；"v2"/"1.2" 这类版本片段丢弃，"25Avatars"/"007"/"伊吹" 保留）；
 *   4) 匹配（a 的 keys × b 的 keys）：完全相等 → score 1.0 / level "same-product"；
 *      否则最长公共子串 L >= max(3, ceil(0.6 × min(len_a, len_b))) → score 0.75 / level "likely"；
 *      都不过（或低于 minScore）→ null（minScore 默认 0.6）。
 *   entryNames（包内一级条目名）与标题/标签并集参与匹配；命中来自包内文件时 reason 用「标题/包内文件共有「X」」。
 */

export interface RelatedInput {
  itemId: number;
  title: string;
  tags?: string[] | null;
  /** 归档里的一级条目名（目录名/文件名），来自 archive_entries 的最外层 */
  entryNames?: string[] | null;
}

export interface RelateOptions {
  /** 归一化后要忽略的 key（头像名/别名、全库高频词）——它们不代表商品。 */
  ignoreKeys?: Iterable<string> | null;
}

/** key 的"信息量"权重：CJK 一个字算 2，拉丁字母/数字算 1。 */
export function keyWeight(key: string): number {
  let w = 0;
  for (const ch of key) w += /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch) ? 2 : 1;
  return w;
}

export interface RelatedMatch {
  itemId: number;
  score: number;                              // 0..1，四位小数
  level: "same-product" | "likely";
  shared: string[];                           // 命中的共有产品名片段（去重、按长度降序，最多 5 个）
  reason: string;                             // 中文一句话，例如：标题/包内文件共有「真実の穴」
}

/** shared 最多返回几条。 */
export const MAX_SHARED = 5;

/** default minScore：0.6 以上才认（1.0 exact / 0.75 likely 都能过）。 */
export const DEFAULT_MIN_SCORE = 0.6;

/**
 * 噪音词（归一化后的独立片段整段相等才丢）——材质/模型/DLC 这类"打包装饰"，
 * 以及包装格式名。注意：只丢独立片段，不做子串替换，避免把产品名里的字切掉。
 */
const NOISE = new Set<string>([
  "material", "materialpack", "materials", "マテリアル", "材質", "材质",
  "texture", "textures", "テクスチャ",
  "model", "モデル", "本体", "body", "prefab",
  "readme",
  "dlc", "set", "セット", "付属", "対応", "対応アバター",
  "ver", "version", "v", "vol", "完整版", "full", "fullpack",
  "pack", "パック", "データ",
  "unitypackage", "zip", "rar", "7z", "psd", "png",
  // 英语功能词：标题里的 "For Manuka" / "The Cave of Truth" 一类，不构成产品名。
  "the", "of", "for", "and", "with",
]);

/** 多词噪音（先按短语删掉，否则会被切成两个独立片段）。 */
const PHRASE_NOISE: RegExp[] = [/\bread\s+me\b/gi];

/** 版本片段：整段形如 "v2" / "ver3" / "1.2" / "1.2.3" / "v1.4"。 */
const VER_DOTTED = /^(?:v|ver|version|バージョン|版本|版)?[._-]?\d{1,4}(?:[._-]\d{1,4}){1,3}$/;
const VER_PREFIXED = /^(?:v|ver|version|バージョン|版本|版)[._-]?\d{1,4}$/;

const CJK = "[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}]";
const CJK_TO_ASCII = new RegExp("(" + CJK + ")(?=[A-Za-z0-9])", "gu");
const ASCII_TO_CJK = new RegExp("([A-Za-z0-9])(?=" + CJK + ")", "gu");

/** 中日文与 ASCII 字母数字的交界处补空格（之后再统一按分隔符切）。 */
function insertScriptBoundaries(s: string): string {
  return s.replace(CJK_TO_ASCII, "$1 ").replace(ASCII_TO_CJK, "$1 ");
}

/** 一个文本 → 原始大小写形态的候选片段（未过滤噪音）。 */
function segmentsOf(text: string): string[] {
  if (typeof text !== "string" || text === "") return [];
  let s = text.normalize("NFKC");
  s = s.replace(/[^\p{L}\p{N}]+/gu, " ");          // emoji/符号/标点/空白 → 空格
  s = insertScriptBoundaries(s);
  for (const re of PHRASE_NOISE) s = s.replace(re, " ");
  return s.split(/\s+/).filter(Boolean);
}

/** 归一化 key：NFKC + 小写（片段已被切成纯字母数字/CJK）。 */
function normOf(seg: string): string { return seg.normalize("NFKC").toLowerCase(); }

/**
 * 片段是否是"版本号"而不是产品名（口径参照 dedupe.parseVersionKey，但要求整段就是版本号）：
 * "v2" / "ver3" / "1.2" / "1.2.3" / "v1.4" 丢；"007"（纯数字）与 "25Avatars"（字母数字混合）留。
 */
function looksLikeVersion(seg: string): boolean {
  const s = normOf(seg);
  return VER_DOTTED.test(s) || VER_PREFIXED.test(s);
}

/** 该片段是否算候选产品名（长度 >= 2、非噪音、非版本）。 */
function isCandidate(seg: string): boolean {
  const n = normOf(seg);
  if ([...n].length < 2) return false;
  if (NOISE.has(n)) return false;
  if (looksLikeVersion(seg)) return false;
  return true;
}

/** 归一化 → 剥离装饰/噪音词 → 候选产品名片段（保留原文大小写形态，按归一化去重）。 */
export function productKeysOf(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const seg of segmentsOf(text)) {
    if (!isCandidate(seg)) continue;
    const n = normOf(seg);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(seg);
  }
  return out;
}

interface KeyHit {
  norm: string;
  surface: string;
  /** 这个 key 也出现在"包内一级条目名"里 */
  entry: boolean;
  /** 只在标签里出现过（标题/包内文件名都没有）—— 弱证据，见 relateItems 的降级规则 */
  tagOnly: boolean;
  /** 出现在标题里 —— 唯一算"强证据"的来源（包内文件名单独命中大多是 per-avatar 目录名） */
  inTitle: boolean;
  /** 两侧的标题里都出现了这个 key —— 才算"同商品"的强证据 */
  inTitleBoth: boolean;
}

/** 一个条目的全部 key（标题 + 标签 + 包内一级条目名并集；同一 key 取首次出现的形态）。 */
function collectKeys(input: RelatedInput, ignore?: Set<string> | null): Map<string, KeyHit> {
  const m = new Map<string, KeyHit>();
  const add = (text: string, kind: "title" | "tag" | "entry"): void => {
    for (const seg of segmentsOf(text)) {
      if (!isCandidate(seg)) continue;
      const n = normOf(seg);
      if (ignore?.has(n)) continue;                     // avatar 名 / 全库高频词：不是"商品名"证据
      const cur = m.get(n);
      if (!cur) m.set(n, { norm: n, surface: seg, entry: kind === "entry", tagOnly: kind === "tag", inTitle: kind === "title", inTitleBoth: false });
      else {
        // 标题 / 包内文件名命中过就不再是"仅标签"；标题形态优先保留（surface 不动）
        if (kind === "entry") { cur.entry = true; cur.tagOnly = false; }
        else if (kind === "title") { cur.tagOnly = false; cur.inTitle = true; }
      }
    }
  };
  add(String(input?.title ?? ""), "title");
  for (const t of input?.tags ?? []) add(String(t ?? ""), "tag");
  for (const e of input?.entryNames ?? []) add(String(e ?? ""), "entry");
  return m;
}

/** 最长公共子串（按字符；不是子序列）。 */
function lcsLength(a: string, b: string): number {
  const A = [...a];
  const B = [...b];
  let best = 0;
  let prev = new Array<number>(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i++) {
    const cur = new Array<number>(B.length + 1).fill(0);
    for (let j = 1; j <= B.length; j++) {
      if (A[i - 1] === B[j - 1]) {
        cur[j] = prev[j - 1]! + 1;
        if (cur[j]! > best) best = cur[j]!;
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * 判定 a / b 是否同一商品。返回 null = 不是（或分数低于 minScore）。
 * 返回的 itemId 是 b 的（调用方拿 a 当"本条"，b 当"对方"）。
 */
export function relateItems(a: RelatedInput, b: RelatedInput, minScore = DEFAULT_MIN_SCORE, opts: RelateOptions = {}): RelatedMatch | null {
  const min = Number.isFinite(minScore) ? minScore : DEFAULT_MIN_SCORE;
  const ignore = opts.ignoreKeys ? new Set<string>(opts.ignoreKeys) : null;
  const A = collectKeys(a, ignore);
  const B = collectKeys(b, ignore);
  if (A.size === 0 || B.size === 0) return null;

  const hits: KeyHit[] = [];
  let exact = false;
  for (const [na, ha] of A) {
    for (const [nb, hb] of B) {
      const la = [...na].length;
      const lb = [...nb].length;
      let matched = false;
      if (na === nb) { matched = true; exact = true; }
      else {
        const L = lcsLength(na, nb);
        if (L >= Math.max(3, Math.ceil(0.6 * Math.min(la, lb)))) matched = true;
      }
      if (matched) hits.push({
        norm: na, surface: ha.surface,
        entry: ha.entry || hb.entry,
        tagOnly: ha.tagOnly && hb.tagOnly,
        inTitle: ha.inTitle || hb.inTitle,
        inTitleBoth: ha.inTitle && hb.inTitle,
      });
    }
  }
  if (hits.length === 0) return null;

  // 只有"标签里出现过"的命中是弱证据：#6 那种 33 个标签的条目会和一堆条目共享
  // VRChat / マヌカ 之类的通用标签，若不降级就会把真正的"包内文件名同名"挤出 limit。
  // 降级到 0.65：默认 min=0.6 时仍可见（排在标题/包内命中之后），min 提到 0.7 就自然过滤掉。
  // 单个"短词"命中不算同商品："pussy" 这种品类词会被一堆商品共用（真実の穴 ↔ 真実の穴_Material 这种
  // 真正的同商品，命中的是 4 个汉字 = 权重 8，够长）。
  const unique = [...new Set(hits.map((h) => h.norm))];
  const tooShort = unique.length === 1 && keyWeight(unique[0]!) < 8;
  // 只有"标题里也出现过的共有片段"才算强证据。包内文件名单独命中大多是 per-avatar 目录名
  // （LUMINA_V2.zip / ICHIGO_V2.zip —— 这些 base 不在头像表里，靠黑名单挡不住），
  // 所以它们只给 0.55：默认 min=0.6 时不会出现，真要放宽可以调 min。
  // 必须**两侧标题都有**才算强证据：只在一侧标题里、另一侧靠包内文件名命中的（LUMINA/ICHIGO 这类
  // 未知 base 名）实测会误报成"同商品"。
  const titleHit = hits.some((h) => h.inTitleBoth);
  const strong = titleHit && !tooShort;
  const allTagOnly = hits.every((h) => h.tagOnly);
  // 标签单独命中给 0.6（正好在默认阈值上：可见但排最后；通用标签已被服务端按文档频率滤掉）；
  // 只靠包内文件名 / 单个短词 → 0.55，默认不出现。
  const score = strong ? (exact ? 1 : 0.75) : allTagOnly ? 0.6 : 0.55;
  if (score < min) return null;

  // 去重（按归一化）、按长度降序、最多 MAX_SHARED 条
  const dedup: KeyHit[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (seen.has(h.norm)) continue;
    seen.add(h.norm);
    dedup.push(h);
  }
  dedup.sort((x, y) => [...y.norm].length - [...x.norm].length);
  const shared = dedup.slice(0, MAX_SHARED).map((h) => h.surface);
  const first = dedup[0]!;
  const reason = (strong ? (first.entry ? "标题/包内文件共有" : "标题共有") : allTagOnly ? "仅标签共有" : tooShort ? "只共有单个短词" : "仅包内文件名共有") + "「" + first.surface + "」";

  return { itemId: b.itemId, score, level: strong && exact ? "same-product" : "likely", shared, reason };
}
