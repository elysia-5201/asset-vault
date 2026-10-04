/**
 * avatars/normalize.ts — 头像别名归一 + 兼容数量声明解析（core-identify）
 * 冻结签名见 docs/CONTRACT.md §4。
 *
 * 归一实现**委托** contracts.ts 的唯一实现 normKey（NFKC + 小写 + 去空白与标点），
 * 在其上只加一层幂等折叠：片假名 → 平假名（并清掉 NFKC 分解残留的组合浊点）。
 * 这样同一模型的不同书写（ミルフィ / みるふぃ / ﾐﾙﾌｨ / Ｍｉｌｆｙ）能落到同一个键上；
 * 罗马字与假名之间不做转写（别名表里两种都列）。
 *
 * 不变量（packages/core/test/avatars/normalize.test.ts 固定）：
 *   1) normKey(normAlias(x)) === normAlias(x)      —— 对 normKey 幂等（lead 要求）
 *   2) normAlias(normAlias(x)) === normAlias(x)    —— 自身幂等
 *   3) normAlias 保持 normKey 的其它性质：全半角/大小写/空白标点不敏感
 * 已知正例/反例对照：
 *   正例：normAlias("✦ ミルフィ :: Milfy 対応 ✦") === "✦みるふぃmilfy対応✦"
 *   正例：normAlias("みるふぃ") === normAlias("ミルフィ") === normAlias("ﾐﾙﾌｨ")
 *   正例：normAlias("ＭＡＮＵＫＡ") === normAlias("manuka") === "manuka"
 *   反例：normAlias("マヌカ") !== normAlias("Manuka")（假名↔罗马字不互转，别名表必须两者都写）
 */

import { normKey } from "../contracts";
import type { KnownAvatar } from "../contracts";

const KATA_OFFSET = 0x30a1 - 0x3041; // ァ..ヶ → ぁ..ゖ

/** 片假名 → 平假名（幂等）；并清掉 ゛゜ 组合记号。 */
export function foldKana(s: string): string {
  if (typeof s !== "string" || s === "") return "";
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp >= 0x30a1 && cp <= 0x30f6) out += String.fromCodePoint(cp - KATA_OFFSET);
    else if (cp >= 0x30fd && cp <= 0x30fe) out += String.fromCodePoint(cp - 0x30fd + 0x309d); // ヽ ヾ
    else if (cp === 0x3099 || cp === 0x309a) continue; // 残留浊点/半浊点
    else out += ch;
  }
  return out;
}

/** 别名/名称归一：normKey（NFKC+小写+去空白标点）+ 假名折叠。 */
export function normAlias(s: string): string {
  return foldKana(normKey(typeof s === "string" ? s : String(s ?? "")));
}

/**
 * 别名索引：normAlias(x) 与 normKey(x) 两个键都登记（都指向头像规范名），
 * 这样服务端用 DB 里的 alias_norm（normKey）查、匹配器用 normAlias 查都不会分叉。
 * 冲突（两个头像归一到同一键）不静默合并：**先登记者胜**，后来者被丢弃；
 * 需要 409 CONFLICT 的判定由服务端用 DB 唯一索引负责（api.md: POST /avatars/:id/aliases）。
 */
export function buildAliasIndex(known: KnownAvatar[]): Map<string, string> {
  const idx = new Map<string, string>();
  if (!Array.isArray(known)) return idx;
  for (const av of known) {
    if (!av || typeof av.name !== "string" || av.name === "") continue;
    const candidates: string[] = [av.name, ...(Array.isArray(av.aliases) ? av.aliases : [])];
    for (const c of candidates) {
      if (typeof c !== "string" || c === "") continue;
      for (const key of [normAlias(c), normKey(c)]) {
        if (key === "" || idx.has(key)) continue;
        idx.set(key, av.name);
      }
    }
  }
  return idx;
}

/**
 * 声明“兼容 N 个模型”的数量（标题优先）：
 *   【12アバター対応】/（7アバター対応）/[19 Avatars]/【6Avatars】/21アバター対応/【4体対応】/12体セット
 * 多个命中时取**位置最靠前**者；同位置按模式优先级。抽不到返回 null。
 * 反例：'しなの専用 ロリ化Prefab & 表情16種セット' => null（16 是表情数不是模型数）
 */
const DECLARED_PATTERNS: RegExp[] = [
  /[【\[(（]\s*(\d{1,3})\s*(?:アバター|avatars?)\s*(?:対応|用|分)?\s*[】\])）]/i,
  /(\d{1,3})\s*アバター\s*(?:対応|用)/,
  /[【\[(（]\s*(\d{1,3})\s*体\s*(?:対応|セット|分)?\s*[】\])）]/,
  /(\d{1,3})\s*体\s*対応/,
  /(\d{1,3})\s*avatars?\b/i,
  /(\d{1,3})\s*体\s*(?:セット|分)/,
];

export function parseDeclaredCount(text: string): number | null {
  if (typeof text !== "string" || text === "") return null;
  let best: { n: number; at: number; p: number } | null = null;
  for (let p = 0; p < DECLARED_PATTERNS.length; p++) {
    const re = DECLARED_PATTERNS[p];
    const m = re.exec(text);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0 || n > 999) continue;
    if (!best || m.index < best.at || (m.index === best.at && p < best.p)) best = { n, at: m.index, p };
  }
  return best ? best.n : null;
}
