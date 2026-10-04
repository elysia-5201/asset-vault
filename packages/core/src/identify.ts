/**
 * identify.ts — 商品号（BOOTH item id）识别（core-identify）
 * 冻结签名见 docs/CONTRACT.md §4。
 *
 * 置信度规则（冻结；由 packages/core/test/identify/identify.test.ts 固定，改动必须同步改测试）：
 *  | 情形                                                        | confidence            |
 *  |-------------------------------------------------------------|-----------------------|
 *  | 显式 BOOTH 商品 URL                                          | 1.00                  |
 *  | 文件名里的“强 token”（两侧是分隔符，或串首/串尾）             | 0.90                  |
 *  | 同一 id 出现在 N 个不同文件名                                 | +0.03*(N-1)，上限 0.99 |
 *  | 文件名里的“弱 token”（嵌在字母数字串里，如 abc6115428def）     | 0.55                  |
 *  | BOOTH downloadable 文件名命中（name/file_name/file_extension）| 0.95（弱 token 0.55） |
 *  | downloadable 与本地文件名同时命中同一 id                      | max(...)+0.04，上限 0.99 |
 *  已知正例/反例对照（真实语料见 docs/CONTRACT.md §5）：
 *    正例：["Loli_Shinano_6115428 对应1.01.zip","Loli_Shinano_6115428 对应1.01.png"] => 6115428 @0.93
 *    反例：["[19 Avatars] citrus shop Soft Texture.7z"] => 无候选（19 不是 5..9 位）
 *    反例：["Oppenheimer.2023.IMAX.1080p.BluRay.x264.DTS-WiKi.rar"] => 无候选（2023/1080 都不到 5 位）
 */

import { AppError } from "./contracts";
import type { IdentifyCandidate, IdentifyResult } from "./contracts";
import { parseBoothUrl } from "./source/booth";

/** 商品号：5..9 位数字，且两侧不能还有数字（14 位时间戳/文件大小整串不会被截出子串）。 */
const ID_RE = /(?<!\d)(\d{5,9})(?!\d)/g;

/** 被视作 token 分隔符的字符（决定 0.90 / 0.55 两档）。 */
const SEP = new Set([
  "_", "-", " ", ".", "[", "]", "(", ")", "（", "）", "【", "】", "{", "}", "#", "+",
  "~", "〜", "・", "「", "」", "'", "’", ",", "，", "/", "\\", "|", ":", "=", "!", "?", "*", "＊",
]);

const STRONG = 0.9;
const WEAK = 0.55;
const DOWNLOADABLE_STRONG = 0.95;
const DOWNLOADABLE_WEAK = 0.55;
const REPEAT_BONUS = 0.03;
const CORROBORATION_BONUS = 0.04;
const CONF_CAP = 0.99;

/**
 * 从任意文本（文件名/路径/URL/用户输入）里抽取全部 5..9 位商品号候选，按首次出现顺序去重。
 * 不做“哪个才对”的判断（那是 identifyFromNames 的活）；单文件多个 id 会全部返回。
 */
export function extractItemIds(text: string): string[] {
  if (typeof text !== "string" || text === "") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  ID_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ID_RE.exec(text)) !== null) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** token 两侧都是分隔符（或串首/串尾）→ 0.90；否则 → 0.55。 */
function tokenConfidence(name: string, start: number, len: number): number {
  const left = start === 0 ? "" : name.charAt(start - 1);
  const right = start + len >= name.length ? "" : name.charAt(start + len);
  const lOk = left === "" || SEP.has(left);
  const rOk = right === "" || SEP.has(right);
  return lOk && rOk ? STRONG : WEAK;
}

interface NameHit {
  id: string;
  confidence: number;
  evidence: string;
}
/** 在单个 name（文件名/路径）里找候选，返回每个 id 的最高分与证据文案。 */
function hitsInName(name: string, prefixed: (id: string, conf: number) => string): NameHit[] {
  const out: NameHit[] = [];
  if (typeof name !== "string" || name === "") return out;
  const best = new Map<string, NameHit>();
  ID_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ID_RE.exec(name)) !== null) {
    const id = m[1];
    const conf = tokenConfidence(name, m.index, id.length);
    const prev = best.get(id);
    if (!prev || conf > prev.confidence) {
      best.set(id, { id, confidence: conf, evidence: prefixed(id, conf) });
    }
  }
  for (const h of best.values()) out.push(h);
  return out;
}

/**
 * 显式 URL → 候选。当前只认 BOOTH 商品 URL / 裸商品号；其它站点或
 * booth.pm/downloadables/<id>（downloadable id 与 item id 不同命名空间）返回 null。
 */
export function identifyFromUrl(url: string): IdentifyCandidate | null {
  const parsed = parseBoothUrl(url);
  if (!parsed) return null;
  const raw = typeof url === "string" ? url.trim() : "";
  const evidence = raw && raw !== parsed.canonicalUrl ? [raw, parsed.canonicalUrl] : [parsed.canonicalUrl];
  return { itemId: parsed.itemId, confidence: 1, method: "url", evidence };
}

/**
 * 从文件名列表（+ 可选 BOOTH downloadable 文件名列表）猜商品号。
 * downloadable 名字由卖家上传时决定，可信度高于本地下载文件名，故 0.95 起步；
 * 两者互相印证时再 +0.04（上限 0.99）。
 */
export function identifyFromNames(names: string[], downloadableNames?: string[]): IdentifyResult {
  const nameList = Array.isArray(names) ? names.filter((n) => typeof n === "string" && n !== "") : [];
  const dlList = Array.isArray(downloadableNames) ? downloadableNames.filter((n) => typeof n === "string" && n !== "") : [];

  interface Acc {
    id: string;
    best: number;
    names: string[];
    dlBest: number;
    dlNames: string[];
    method: "filename" | "downloadable_name";
  }
  const acc = new Map<string, Acc>();
  const touch = (id: string): Acc => {
    let a = acc.get(id);
    if (!a) {
      a = { id, best: 0, names: [], dlBest: 0, dlNames: [], method: "filename" };
      acc.set(id, a);
    }
    return a;
  };

  for (const name of nameList) {
    for (const h of hitsInName(name, (id) => "filename: " + name)) {
      const a = touch(h.id);
      a.best = Math.max(a.best, h.confidence);
      if (!a.names.includes(name)) a.names.push(name);
    }
  }
  for (const name of dlList) {
    for (const h of hitsInName(name, (id) => "downloadable: " + name)) {
      const a = touch(h.id);
      // downloadable 名字由卖家上传时决定，可信度高于本地下载文件名（强 token 0.95 / 弱 token 0.55）
      const conf = h.confidence >= STRONG ? DOWNLOADABLE_STRONG : DOWNLOADABLE_WEAK;
      a.dlBest = Math.max(a.dlBest, conf);
      if (!a.dlNames.includes(name)) a.dlNames.push(name);
    }
  }

  const candidates: IdentifyCandidate[] = [];
  for (const a of acc.values()) {
    const hasDl = a.dlNames.length > 0;
    const hasFn = a.names.length > 0;
    let confidence: number;
    if (hasDl && hasFn) {
      confidence = Math.min(CONF_CAP, Math.max(a.dlBest, a.best) + CORROBORATION_BONUS);
      a.method = "downloadable_name";
    } else if (hasDl) {
      confidence = a.dlBest;
      a.method = "downloadable_name";
    } else {
      confidence = Math.min(CONF_CAP, a.best + REPEAT_BONUS * (a.names.length - 1));
    }
    const evidence: string[] = [];
    for (const n of a.dlNames) evidence.push("downloadable: " + n);
    for (const n of a.names) evidence.push("filename: " + n);
    candidates.push({ itemId: a.id, confidence: Math.round(confidence * 1000) / 1000, method: a.method, evidence });
  }

  candidates.sort((x, y) => (y.confidence - x.confidence) || (x.itemId < y.itemId ? -1 : x.itemId > y.itemId ? 1 : 0));
  return { candidates, best: candidates.length > 0 ? candidates[0] : null };
}

/**
 * 商品号 → 规范 URL。itemId 非 5..9 位数字 → AppError(INVALID_INPUT)（api.md: 400 INVALID_INPUT）。
 * locale 非法时回落 ja；canonical 一律 ja（与 parseBoothUrl 的 canonicalUrl 对齐，便于去重）。
 */
export function boothUrl(itemId: string, locale = "ja"): string {
  const id = typeof itemId === "string" ? itemId.trim() : String(itemId ?? "").trim();
  if (!/^\d{5,9}$/.test(id)) {
    throw new AppError("INVALID_INPUT", "invalid BOOTH item id: " + String(itemId));
  }
  const loc = typeof locale === "string" && /^[a-z]{2}(-[a-z]{2})?$/i.test(locale) ? locale.toLowerCase() : "ja";
  return "https://booth.pm/" + loc + "/items/" + id;
}
