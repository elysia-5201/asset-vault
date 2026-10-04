/**
 * avatars/detect.ts — 识别“这个商品支持哪些模型”（core-identify）
 * 冻结签名见 docs/CONTRACT.md §4。
 *
 * 六类证据（AvatarEvidenceSource）与权重（冻结；测试 packages/core/test/avatars/detect.test.ts 固定）：
 *   | 证据                       | 说明                                                        | 权重 |
 *   |----------------------------|-------------------------------------------------------------|------|
 *   | unitypackage_path          | Assets/<Model>/… 整段相等                                    | 0.90 |
 *   |                            | 文件/目录名里出现（如 …/Shinano_Daisy.fbx）                   | 0.75 |
 *   | booth_tag                  | BOOTH 标签，去掉 〜対応/〜用/〜専用 后缀后命中                 | 0.85 |
 *   | archive_path               | 压缩包内路径整段相等（顶层目录名如 Shinano/…）                 | 0.80 |
 *   |                            | 路径段里出现（如 Outfit_Shinano/…）                          | 0.60 |
 *   | title                      | 标题里出现                                                   | 0.75 |
 *   | filename                   | 本地文件名（整名等于别名 0.70 / 名内含 0.60）                  | 0.60/0.70 |
 *   | description                | 描述里出现（同行有 対応/専用/サポート 等支持语 → 0.60，否则 0.50） | 0.50/0.60 |
 *   | declared_count             | 声明数 == 命中数时对每个命中加权（互证）                       | 0.25 |
 * 合成：confidence = 1 - Π(1 - w_i)（每类证据只取最高权重），四舍五入到 3 位小数，上限 1。
 * 规划中（planned）：描述里 “▼今後対応予定▼” 之后的名单**不算已支持**，从描述证据里剔除并进 planned。
 * 已知正例/反例对照（真实语料，2026-10-04 抓取）：
 *   正例：BOOTH 6494376「【6Avatars】Cat's Round Eye」tags 含 MANUKA対応/Shinano対応/Airi対応/Sio対応/Chocolat対応/彼方
 *        → 6 个命中 + declared_count 6；描述 ▼今後対応予定▼ 下的 Komano/Milltina 进 planned、不算命中
 *   反例：把同一个 6494376 的标题换成「【6Avatars】Cat's Round Eye」但清空 tags/描述 → 命中数 0（不凭数量硬凑）
 *   反例（拉丁别名边际规则）：真实文件名 "Milky-Way.zip"、品牌词 "MilkyWay" 都不命中 Milfy ——
 *        拉丁别名要求**词边界**（两侧不能是字母/数字），所以 "milfy" 不会落在 "milkyway" 里；
 *        但别名后面允许紧跟日文后缀/助词（"Sio対応" / "Shinanoちゃん" / "Sioの"），因为日文没有空格分词。
 *        对照："passion" / "sion" / "Sioress" 同样不命中 Sio，而 "Sio対応" / "【Sio】" 命中。
 *   反例（CJK 别名边际规则）：CJK 用归一化包含判定（日文无词边界），因此别名表必须避免 1 字别名 ——
 *        已硬性过滤：拉丁别名 norm 长度 < 3 丢弃、CJK 别名 < 2 丢弃（如 "Sio" 保留、"Ai" 丢弃、"しお" 保留）。
 *   反例（声明数反退化）：真实 "[19 Avatars] citrus shop Soft Texture.7z" 只有数量没有模型名 →
 *        0 命中；即使给它一条无关标签导致 1 命中，19 ≠ 1 也不加 declared_count 互证。
 */

import type {
  AvatarDetectionInput, AvatarDetectionResult, AvatarEvidenceSource, AvatarHit, KnownAvatar,
} from "../contracts";
import { buildAliasIndex, normAlias, parseDeclaredCount } from "./normalize";

/** 各类证据的基础权重（同类证据取最大值）。 */
const SOURCE_WEIGHT: Record<AvatarEvidenceSource, number> = {
  unitypackage_path: 0.9,
  booth_tag: 0.85,
  archive_path: 0.8,
  title: 0.75,
  filename: 0.6,
  description: 0.5,
  declared_count: 0.25,
  manual: 1,
};
const UNITY_TOKEN_WEIGHT = 0.75;
const ARCHIVE_CONTAINS_WEIGHT = 0.6;
const FILENAME_EXACT_WEIGHT = 0.7;
const FILENAME_CONTAINS_WEIGHT = 0.6;
const DESCRIPTION_SUPPORT_WEIGHT = 0.6;

/** 太短的别名会误伤（"Sio" 落在 "passion" 里），拉丁别名至少 3 字符、CJK 至少 2 字符。 */
const MIN_LATIN_ALIAS = 3;
const MIN_CJK_ALIAS = 2;

interface AliasDef { raw: string; search: string; latin: boolean }
interface AvatarDef { name: string; aliases: AliasDef[] }

/** 是否是 BOOTH 标签里的“支持”后缀（去掉后才是模型名）。 */
const TAG_SUFFIX_RE = /[\s\u3000]*(?:対応|専用|用|向け|용)\s*$/u;

const PLANNED_MARKERS: RegExp[] = [
  /▼[\s]*今後[\s]*対応[\s]*予定[\s]*▼?/,
  /今後[\s]*対応[\s]*予定/,
  /対応[\s]*予定[\s]*▼/,
  /今後[\s]*追加[\s]*予定/,
  /近日[\s]*対応[\s]*予定/,
];
const SUPPORT_WORDS = /(対応|専用|サポート|対応済|使用でき|使え)/;

export function buildAvatarDefs(known: KnownAvatar[]): AvatarDef[] {
  const defs: AvatarDef[] = [];
  const seen = new Set<string>();
  for (const av of Array.isArray(known) ? known : []) {
    if (!av || typeof av.name !== "string" || av.name === "" || seen.has(av.name)) continue;
    seen.add(av.name);
    const raws = [av.name, ...(Array.isArray(av.aliases) ? av.aliases : [])];
    const aliases: AliasDef[] = [];
    const seenAlias = new Set<string>();
    for (const r of raws) {
      if (typeof r !== "string" || r.trim() === "") continue;
      const key = normAlias(r);
      if (key === "" || seenAlias.has(key)) continue;
      seenAlias.add(key);
      const latin = /^[a-z0-9]+$/.test(key);
      const len = [...key].length;
      if (latin ? len < MIN_LATIN_ALIAS : len < MIN_CJK_ALIAS) continue;
      aliases.push({ raw: r, search: r.normalize("NFKC").toLowerCase(), latin });
    }
    defs.push({ name: av.name, aliases });
  }
  return defs;
}

function isWordChar(c: string): boolean {
  return c !== "" && /[\p{L}\p{N}]/u.test(c);
}

/** 拉丁别名后面紧跟这些日文后缀/助词时也算词边界（"Sio対応" / "Shinanoちゃん" / "Sioの"）。 */
const POST_MARKERS: string[] = ["対応", "専用", "向け", "モデル", "ちゃん", "さん", "くん", "용", "用", "版"];
const POST_PARTICLES = "はがをにのともでへやかねよ";
function latinBoundaryOk(hay: string, at: number, len: number): boolean {
  if (isWordChar(hay.charAt(at - 1))) return false;
  const after = hay.charAt(at + len);
  if (!isWordChar(after)) return true;
  if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(after)) {
    const rest = hay.slice(at + len);
    if (POST_MARKERS.some((m) => rest.startsWith(m))) return true;
    if (POST_PARTICLES.includes(after)) return true;
  }
  return false;
}

interface TextHit { name: string; alias: string; exact: boolean }

/** 在一段文本里找所有命中（拉丁词边界；CJK 用归一包含；假名/全半角不敏感）。 */
export function matchAvatarsInText(text: string, defs: AvatarDef[]): TextHit[] {
  if (typeof text !== "string" || text === "") return [];
  const hayLower = text.normalize("NFKC").toLowerCase();
  const textNorm = normAlias(text);
  const out: TextHit[] = [];
  for (const d of defs) {
    let hit: TextHit | null = null;
    for (const a of d.aliases) {
      if (a.search === "") continue;
      let found = false;
      let at = hayLower.indexOf(a.search);
      while (at !== -1) {
        if (!a.latin || latinBoundaryOk(hayLower, at, a.search.length)) {
          found = true;
          break;
        }
        at = hayLower.indexOf(a.search, at + 1);
      }
      if (!found && !a.latin) {
        const na = normAlias(a.raw);
        if (na !== "" && textNorm.includes(na)) found = true;
      }
      if (found) {
        hit = { name: d.name, alias: a.raw, exact: normAlias(a.raw) === textNorm };
        break;
      }
    }
    if (hit) out.push(hit);
  }
  return out;
}

/** 提取 “▼今後対応予定▼ …” 名单区（到空行或 ※/▼/■/●/# 等标记行为止），返回名单区与被剔除后的正文。 */
export function extractPlannedRegion(description: string): { region: string; rest: string } {
  if (typeof description !== "string" || description === "") return { region: "", rest: "" };
  const lines = description.split(/\r?\n/);
  let start = -1;
  let inlineTail = "";
  for (let i = 0; i < lines.length && start === -1; i++) {
    for (const re of PLANNED_MARKERS) {
      const m = re.exec(lines[i]);
      if (m) {
        start = i;
        inlineTail = lines[i].slice((m.index ?? 0) + m[0].length).trim();
        break;
      }
    }
  }
  if (start === -1) return { region: "", rest: description };
  const regionLines: string[] = [];
  if (inlineTail !== "") regionLines.push(inlineTail);
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "" || /^[※▼■●◆◇#*\-=【]/.test(t)) break;
    regionLines.push(t);
  }
  return { region: regionLines.join("\n"), rest: lines.slice(0, start).join("\n") };
}

function baseStem(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  return base.replace(/\.[A-Za-z0-9]{1,8}$/, "");
}

function confidenceOf(weights: number[]): number {
  let miss = 1;
  for (const w of weights) miss *= 1 - w;
  return Math.round((1 - miss) * 1000) / 1000;
}

/**
 * 识别商品支持的模型。命中按 confidence 降序（同分按名字升序）返回；
 * declaredCount 来自标题（标题没有再看描述）；planned 是“今后対応予定”名单。
 */
export function detectAvatars(input: AvatarDetectionInput, known: KnownAvatar[]): AvatarDetectionResult {
  const i = input ?? {};
  const defs = buildAvatarDefs(known);

  interface Acc { name: string; weights: Map<AvatarEvidenceSource, number>; evidence: string[] }
  const acc = new Map<string, Acc>();
  const add = (name: string, source: AvatarEvidenceSource, weight: number, evidence: string): void => {
    let a = acc.get(name);
    if (!a) {
      a = { name, weights: new Map(), evidence: [] };
      acc.set(name, a);
    }
    const prev = a.weights.get(source) ?? 0;
    if (weight > prev) a.weights.set(source, weight);
    if (!a.evidence.includes(evidence)) a.evidence.push(evidence);
  };

  // ① 标题
  const title = typeof i.title === "string" ? i.title : "";
  for (const h of matchAvatarsInText(title, defs)) {
    add(h.name, "title", SOURCE_WEIGHT.title, 'title: matched "' + h.alias + '"');
  }

  // ② BOOTH 标签（去掉 〜対応 / 〜用 / 〜専用 后缀再匹配）
  const tags = Array.isArray(i.tags) ? i.tags : [];
  for (const tag of tags) {
    if (typeof tag !== "string" || tag.trim() === "") continue;
    const fq = tag.normalize("NFKC").trim();
    const variants = [fq];
    const stripped = fq.replace(TAG_SUFFIX_RE, "").trim();
    if (stripped !== "" && stripped !== fq) variants.push(stripped);
    const hits = new Map<string, TextHit>();
    for (const v of variants) {
      for (const h of matchAvatarsInText(v, defs)) if (!hits.has(h.name)) hits.set(h.name, h);
    }
    for (const h of hits.values()) {
      add(h.name, "booth_tag", SOURCE_WEIGHT.booth_tag, 'booth_tag: "' + tag + '"');
    }
  }

  // ③ 描述（剔除“今后対応予定”区，避免把 planned 当已支持）
  const description = typeof i.description === "string" ? i.description : "";
  const plannedSplit = extractPlannedRegion(description);
  for (const line of plannedSplit.rest.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const w = SUPPORT_WORDS.test(line) ? DESCRIPTION_SUPPORT_WEIGHT : SOURCE_WEIGHT.description;
    for (const h of matchAvatarsInText(line, defs)) {
      add(h.name, "description", w, 'description: matched "' + h.alias + '"');
    }
  }

  // ④ 压缩包内路径
  const archivePaths = Array.isArray(i.archivePaths) ? i.archivePaths : [];
  const unityPaths = Array.isArray(i.unitypackagePaths) ? i.unitypackagePaths : [];
  const pathPass = (
    paths: Array<string | null | undefined>,
    source: "archive_path" | "unitypackage_path",
    exactW: number,
    containsW: number,
  ): void => {
    for (const p of paths) {
      if (typeof p !== "string" || p === "") continue;
      const segs = p.replace(/\\/g, "/").split("/").filter((s) => s !== "");
      const exact = new Set<string>();
      for (const seg of segs) {
        const n = normAlias(seg);
        if (n === "") continue;
        for (const d of defs) {
          if (d.aliases.some((a) => normAlias(a.raw) === n)) exact.add(d.name);
        }
      }
      if (exact.size > 0) {
        for (const name of exact) add(name, source, exactW, source + ': "' + p + '"');
        continue;
      }
      const hits = new Map<string, TextHit>();
      for (const seg of segs) {
        const stem = seg.replace(/\.[A-Za-z0-9]{1,8}$/, "");
        if (stem === "") continue;
        for (const h of matchAvatarsInText(stem, defs)) if (!hits.has(h.name)) hits.set(h.name, h);
      }
      for (const h of hits.values()) add(h.name, source, containsW, source + ': "' + p + '"');
    }
  };
  pathPass(archivePaths, "archive_path", SOURCE_WEIGHT.archive_path, ARCHIVE_CONTAINS_WEIGHT);
  pathPass(unityPaths, "unitypackage_path", SOURCE_WEIGHT.unitypackage_path, UNITY_TOKEN_WEIGHT);

  // ⑤ 本地文件名
  const fileNames = Array.isArray(i.fileNames) ? i.fileNames : [];
  for (const f of fileNames) {
    if (typeof f !== "string" || f === "") continue;
    const stem = baseStem(f);
    for (const h of matchAvatarsInText(stem, defs)) {
      add(h.name, "filename", h.exact ? FILENAME_EXACT_WEIGHT : FILENAME_CONTAINS_WEIGHT, 'filename: "' + f + '"');
    }
  }

  // ⑥ 声明数量互证（声明数 == 命中数时才加权）
  const declaredTitle = parseDeclaredCount(title);
  const declaredCount = declaredTitle !== null ? declaredTitle : parseDeclaredCount(description);
  if (declaredCount !== null && acc.size === declaredCount) {
    for (const a of acc.values()) {
      a.weights.set("declared_count", SOURCE_WEIGHT.declared_count);
      a.evidence.push("declared_count: " + declaredCount + " (hits=" + acc.size + ")");
    }
  }

  const hits: AvatarHit[] = [];
  for (const a of acc.values()) {
    const sources = [...a.weights.keys()];
    hits.push({ name: a.name, confidence: confidenceOf([...a.weights.values()]), sources, evidence: a.evidence });
  }
  hits.sort((x, y) => (y.confidence - x.confidence) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));

  // planned：名单区里的模型（认识的给规范名，不认识的保留原文，供人工确认）；
  // 已在 hits 里的（标题/标签/路径另有证据）不再进 planned，避免“既支持又计划中”的自相矛盾。
  const planned: string[] = [];
  const hitNames = new Set(hits.map((h) => h.name));
  if (plannedSplit.region !== "") {
    for (const line of plannedSplit.region.split(/\r?\n/)) {
      const t = line.trim();
      if (t === "") continue;
      const found = matchAvatarsInText(t, defs);
      if (found.length > 0) {
        for (const h of found) if (!hitNames.has(h.name) && !planned.includes(h.name)) planned.push(h.name);
      } else {
        const raw = t.slice(0, 60);
        if (!hitNames.has(raw) && !planned.includes(raw)) planned.push(raw);
      }
    }
  }

  return { hits, declaredCount, planned };
}

/**
 * 资产级标注：给每个路径找出它属于哪个模型，并给出 entry_prefix（到命中段为止的路径前缀，含尾斜杠）。
 * 规则：优先“整段相等”的命中（取最靠前的段）；没有整段相等时退化为“段内出现”（取最靠前的段上所有命中）。
 * 正例：Assets/Shinano/Texture/x.png + known[Shinano] => [{ name:"Shinano", prefix:"Assets/Shinano/" }]
 * 正例：Shinano/emission/blue.png          + known[Shinano] => [{ name:"Shinano", prefix:"Shinano/" }]
 * 反例：Assets/MANUKA/Texture/Shinano_face.png + known[MANUKA,Shinano] => 只有 MANUKA（整段相等优先）
 */
export function avatarNamesFromPaths(paths: string[], known: KnownAvatar[]): { name: string; prefix: string }[] {
  const defs = buildAvatarDefs(known);
  const out: { name: string; prefix: string }[] = [];
  const seen = new Set<string>();
  const push = (name: string, prefix: string): void => {
    const key = name + "\u0000" + prefix;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, prefix });
  };
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== "string" || p === "") continue;
    const segs = p.replace(/\\/g, "/").split("/").filter((s) => s !== "");
    let exactIdx = -1;
    let exactNames: string[] = [];
    for (let i = 0; i < segs.length; i++) {
      const n = normAlias(segs[i]);
      if (n === "") continue;
      const names: string[] = [];
      for (const d of defs) {
        if (d.aliases.some((a) => normAlias(a.raw) === n)) names.push(d.name);
      }
      if (names.length > 0) {
        exactIdx = i;
        exactNames = names;
        break;
      }
    }
    if (exactIdx >= 0) {
      const prefix = segs.slice(0, exactIdx + 1).join("/") + "/";
      for (const n of exactNames) push(n, prefix);
      continue;
    }
    let containsIdx = -1;
    let containsNames: string[] = [];
    for (let i = 0; i < segs.length; i++) {
      const stem = segs[i].replace(/\.[A-Za-z0-9]{1,8}$/, "");
      if (stem === "") continue;
      const hits = matchAvatarsInText(stem, defs);
      if (hits.length > 0) {
        containsIdx = i;
        containsNames = hits.map((h) => h.name);
        break;
      }
    }
    if (containsIdx >= 0) {
      const prefix = segs.slice(0, containsIdx + 1).join("/") + "/";
      for (const n of containsNames) push(n, prefix);
    }
  }
  return out;
}
