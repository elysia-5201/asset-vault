/**
 * structure.ts — 容器/Unity 包结构识别与"资源单元关系"建议（纯函数，无 DB / 无 IO）
 *
 * 职责边界（task-37）：
 *  - detectUnitAvatars：把"文件名 / 包内路径 / item_avatar"翻译成**模型证据**（带等级与命中文本）。
 *  - decidePolicy：决定这个资源单元是什么结构（多层容器？混合包？单模型包？判不了就 unknown）。
 *  - relationCandidates：给出资源单元之间**可建议**的关系（伴生素材 / 可选变体），绝不越权到 confirmed。
 *
 * 关键纪律（与 lead 的验收口径一致）：
 *  1) 证据等级：item_avatar（人工确认）→ confirmed；文件名/包内路径 → probable；无命中不返回。
 *  2) mixed **只能**由"≥2 个不同模型证据"或显式 mixedConfirmed 得出；外层 ZIP 本身不构成 mixed 理由
 *     （ZIP 里多个 upkg 是"多独立包容器"，不是"一个混合包"）。
 *  3) 解析不完整（partial/failed）且判不了 → unknown_structure，**不猜**。
 *  4) 关系只输出 probable；confirmed 需要 README/GUID 级证据（本模块没有，故永不输出 confirmed）。
 *
 * 归一化复用既有实现（不写第二套）：avatars/normalize.ts 的 normAlias（NFKC 全半角 + 小写 + 去标点 + 假名折叠）
 * 与 avatars/detect.ts 的 matchAvatarsInText（拉丁词边界 / CJK 包含 / 假名不敏感）。
 */
import type { KnownAvatar } from "./contracts";
import { buildAvatarDefs, matchAvatarsInText } from "./avatars/detect";
import { normAlias } from "./avatars/normalize";

// ---------------------------------------------------------------- 公共类型

export type StructurePolicy = "multi_package_container" | "mixed_unitypackage" | "single_unitypackage" | "unknown_structure";

export type EvidenceLevel = "confirmed" | "probable" | "unknown" | "conflict";

/** 模型的最小投影（jobs-dev 从 DB 读出来即可，不需要 AvatarRow 全字段）。 */
export interface AvatarLite { id: number; name: string; aliases?: string[] }

export type AvatarEvidenceVia = "filename" | "package_path" | "item_avatar" | "booth_meta" | "manual";

export interface AvatarEvidence {
  avatarId: number;
  /** 最强的那条证据来源（同 avatar 多来源合并时取最强） */
  via: AvatarEvidenceVia;
  /** confirmed = item_avatar/manual；probable = 文件名/包内路径 */
  level: EvidenceLevel;
  /** 命中的原文（去重、按出现顺序）；item_avatar 记为 item_avatar:<avatarId> */
  hits: string[];
}

export interface DecidePolicyInput {
  /** ContainerKind（zip/7z/rar/unitypackage/dir/file），仅用于 reason 文案 */
  container: string;
  /** AssetKind（archive/unitypackage/folder/loose_file/image_set） */
  kind: string;
  /** 该单元内（含一层）发现的 .unitypackage 路径 */
  innerUnitypackagePaths: string[];
  /** 已识别出的**不同**模型数（由 detectUnitAvatars / DB 证据算好传进来） */
  mixedAvatarCount: number;
  parseState: "ok" | "partial" | "failed";
  /** 人工/元数据显式确认这是混合包（最高优先级，但只用于 mixed，不外推到其它判断） */
  mixedConfirmed?: boolean;
}

export interface StructureDecision { policy: StructurePolicy; reason: string }

export interface StructureUnit { id: string; name: string; avatarIds: number[]; kind: string }

export interface RelationOptions {
  /** 每个单元最多给出多少条关系（默认 8，防组合爆炸） */
  limitPerUnit?: number;
}

export interface UnitRelation {
  from: string;
  to: string;
  type: "suggested_companion" | "optional_variant" | "explicit_dependency";
  evidence: string;
  /** 本模块只产出 probable；confirmed 需要 README/GUID 级证据 */
  confidence: "confirmed" | "probable";
}

// ---------------------------------------------------------------- 证据分级

const VIA_RANK: Record<AvatarEvidenceVia, number> = { item_avatar: 4, manual: 3, booth_meta: 2.5, filename: 2, package_path: 1 };
const LEVEL_RANK: Record<EvidenceLevel, number> = { confirmed: 4, probable: 3, conflict: 2, unknown: 1 };

/** 文本里含路径分隔符 → 包内路径；否则当文件名。 */
function viaOfText(text: string): AvatarEvidenceVia {
  return /[\\/]/.test(text) ? "package_path" : "filename";
}

/**
 * 从若干文本里识别"这个单元涉及哪些模型"。
 *
 * - 归一化：NFKC（全半角）+ 小写 + 去标点 + 假名折叠 + 拉丁词边界（复用 avatars/detect.ts）
 * - via：文本含 "/" 或 "\" → package_path，否则 filename（两者都是 probable）
 * - itemAvatarIds：item_avatar 证据 → confirmed，与文本证据按 avatar 合并，等级取高者（confirmed 胜）
 * - 同一 avatar 的多条命中合并进 hits；无命中的 avatar 不返回
 */
export function detectUnitAvatars(texts: string[], avatars: AvatarLite[], itemAvatarIds?: number[]): AvatarEvidence[] {
  const list = (Array.isArray(avatars) ? avatars : []).filter((a) => a && typeof a.name === "string" && a.name !== "");
  if (list.length === 0) return [];

  const idByName = new Map<string, number>();
  const known: KnownAvatar[] = [];
  for (const a of list) {
    if (!idByName.has(a.name)) { idByName.set(a.name, a.id); known.push({ name: a.name, aliases: Array.isArray(a.aliases) ? a.aliases : [], kind: "unknown" }); }
  }
  const defs = buildAvatarDefs(known);

  const merged = new Map<number, { via: AvatarEvidenceVia; level: EvidenceLevel; hits: string[]; seen: Set<string> }>();
  const merge = (avatarId: number, via: AvatarEvidenceVia, level: EvidenceLevel, hit: string): void => {
    const cur = merged.get(avatarId);
    if (!cur) { merged.set(avatarId, { via, level, hits: [hit], seen: new Set([hit]) }); return; }
    if (VIA_RANK[via] > VIA_RANK[cur.via]) cur.via = via;
    if (LEVEL_RANK[level] > LEVEL_RANK[cur.level]) cur.level = level;
    if (!cur.seen.has(hit)) { cur.seen.add(hit); cur.hits.push(hit); }
  };

  for (const raw of Array.isArray(texts) ? texts : []) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const via = viaOfText(raw);
    for (const hit of matchAvatarsInText(raw, defs)) {
      const id = idByName.get(hit.name);
      if (id === undefined) continue;
      merge(id, via, "probable", raw);
    }
  }

  const ids = new Set(list.map((a) => a.id));
  for (const id of Array.isArray(itemAvatarIds) ? itemAvatarIds : []) {
    if (!Number.isFinite(id) || !ids.has(id)) continue;
    merge(id, "item_avatar", "confirmed", "item_avatar:" + id);
  }

  return [...merged.entries()]
    .map(([avatarId, v]) => ({ avatarId, via: v.via, level: v.level, hits: v.hits }))
    .sort((a, b) => (LEVEL_RANK[b.level] - LEVEL_RANK[a.level]) || (a.avatarId - b.avatarId));
}

// ---------------------------------------------------------------- 结构判定

function uniqPaths(paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== "string") continue;
    const t = p.trim();
    if (t === "" || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * 结构判定（决定性优先级）：
 *
 * kind=unitypackage：
 *   mixedConfirmed 或 mixedAvatarCount>=2 → mixed_unitypackage（"≥2 个不同模型"是硬证据，partial 也采信）
 *   解析成功且证据不足 → single_unitypackage
 *   解析不完整且判不了 → unknown_structure
 *
 * kind=archive：
 *   inner > 1 → multi_package_container（多独立包；**不**因外层 ZIP 就把混合包当可拆）
 *   inner == 1 → 按该 upkg 判：mixedConfirmed 或 count>=2 → mixed_unitypackage；否则解析成功 → single；否则 unknown
 *   inner == 0 → unknown_structure（不是 Unity 包容器）
 *
 * 其它 kind / 解析失败 → unknown_structure。
 */
export function decidePolicy(input: DecidePolicyInput): StructureDecision {
  const container = String(input?.container ?? "");
  const kind = String(input?.kind ?? "");
  const inner = uniqPaths(input?.innerUnitypackagePaths ?? []);
  const count = Number.isFinite(input?.mixedAvatarCount) ? Math.max(0, Math.floor(Number(input.mixedAvatarCount))) : 0;
  const parseState = input?.parseState === "failed" ? "failed" : input?.parseState === "partial" ? "partial" : "ok";
  const mixedConfirmed = input?.mixedConfirmed === true;
  const mixedEvidence = mixedConfirmed || count >= 2;

  const mixed = (): StructureDecision => ({
    policy: "mixed_unitypackage",
    reason: mixedConfirmed
      ? "显式确认的混合包（mixedConfirmed）"
      : "证据显示支持 " + count + " 个不同模型（≥2）",
  });
  const unknown = (reason: string): StructureDecision => ({ policy: "unknown_structure", reason });
  const single = (): StructureDecision => ({ policy: "single_unitypackage", reason: "单个模型/无多模型证据（" + count + " 个模型证据）" });

  if (kind === "unitypackage") {
    if (mixedEvidence) return mixed();
    if (parseState !== "ok") return unknown("unitypackage 解析不完整（" + parseState + "）且无多模型证据，无法判定结构");
    return single();
  }

  if (kind === "archive") {
    if (parseState === "failed") return unknown("压缩包解析失败，无法判断内部是否含 unitypackage");
    if (inner.length > 1) {
      return {
        policy: "multi_package_container",
        reason: "外层 " + (container || "压缩包") + " 内含 " + inner.length + " 个独立 unitypackage（逐包处理，不整体当混合包拆）",
      };
    }
    if (inner.length === 1) {
      if (mixedEvidence) return mixed();
      if (parseState !== "ok") return unknown("外层由 1 个 unitypackage 构成，但该包解析不完整（" + parseState + "），无法判定单模型/混合");
      return { policy: "single_unitypackage", reason: "外层 " + (container || "压缩包") + " 仅含 1 个 unitypackage，且无多模型证据" };
    }
    return unknown("" + (container || "压缩包") + " 内未发现 unitypackage，不是 Unity 包容器");
  }

  if (parseState === "failed") return unknown("解析失败，无法判定结构");
  return unknown("kind=" + (kind || "?") + " 不是 unitypackage/archive，结构规则不适用");
}

// ---------------------------------------------------------------- 关系建议

/** 伴生素材后缀（归一化后没有标点，直接按词尾剥离）。长的先剥，避免 "materials" 被 "material" 截断。 */
const COMPANION_SUFFIXES = [
  "materialpack", "materials", "material", "textures", "texture", "tex", "mat",
  "prefab", "model", "mesh", "shader", "psd", "png", "jpg",
  "テクスチャ素材", "テクスチャ", "マテリアル", "モデル", "メッシュ", "シェーダー", "素材",
  "材质包", "材质", "材質", "贴图", "貼圖", "模型",
];

interface NameStem { stem: string; stripped: boolean; variantKey: string; normName: string }

/** 版本尾巴：v2 / ver2 / 2 / 第2 —— 用于"同名变体"归并（不用于伴生判定）。 */
const VERSION_TAIL_RE = /(?:ver)?v?\d{1,2}$/;

/**
 * 已知扩展名（长扩展名必须显式列出：通用规则只处理 1..6 位，而 ".unitypackage" 是 12 字符）。
 * 服务端传进来的 unit.name 常常是磁盘文件名（MANUKA_model.unitypackage），
 * 不先剥掉它，"model" 后缀与主干匹配就全失效（verifier B-1c 根因）。
 */
const KNOWN_EXTS = new Set([
  "unitypackage", "zip", "7z", "rar", "tar", "gz",
  "png", "jpg", "jpeg", "webp", "psd", "tga", "fbx", "prefab", "asset",
  "mat", "anim", "controller", "shader", "cs", "wav", "mp3", "ogg",
]);

/** 去扩展名：短的（<=6）一律剥；更长的只剥 KNOWN_EXTS 里的，避免误伤 Outfit.v2 这类版本名。 */
function stripKnownExtension(name: string): string {
  const m = /\.([A-Za-z0-9]{1,16})$/.exec(name);
  if (!m || m.index <= 0) return name;
  const ext = (m[1] ?? "").toLowerCase();
  if (ext.length <= 6 || KNOWN_EXTS.has(ext)) return name.slice(0, m.index);
  return name;
}

/** 名称 → 主干：去扩展名 → normAlias → 循环剥离伴生后缀（主干至少留 2 字符）。 */
function stemOf(name: string): NameStem {
  const s = stripKnownExtension(String(name ?? ""));
  let norm = normAlias(s);
  let stripped = false;
  for (let guard = 0; guard < 4; guard++) {
    let hit = false;
    for (const suf of COMPANION_SUFFIXES) {
      if (norm.length > suf.length + 1 && norm.endsWith(suf)) {
        norm = norm.slice(0, -suf.length);
        stripped = true;
        hit = true;
        break;
      }
    }
    if (!hit) break;
  }
  const variant = norm.replace(VERSION_TAIL_RE, "");
  // normName 也从"去扩展名后"的名称算：同一单元换了容器扩展名（.unitypackage / .zip）应算同名重复，而不是产生关系
  return { stem: norm, stripped, variantKey: variant.length >= 2 ? variant : norm, normName: normAlias(s) };
}

function sharesAvatar(a: number[], b: number[]): number | null {
  const set = new Set((a ?? []).filter((x) => Number.isFinite(x)));
  for (const x of b ?? []) if (set.has(x)) return x;
  return null;
}

/**
 * 资源单元之间的关系建议。
 *
 * 规则（都只到 probable）：
 *  - 同 avatar + 名称主干相同（去掉 v2/2 这类版本尾巴）→ optional_variant
 *  - 名称主干相同、且至少一侧削掉了"材质/贴图/模型"后缀 → suggested_companion
 *  - 其余不产出（宁缺勿滥）
 *
 * 本函数**永不**输出 confidence='confirmed'：没有 README/GUID/依赖声明级证据时，关系只能是建议。
 */
export function relationCandidates(units: StructureUnit[], opts: RelationOptions = {}): UnitRelation[] {
  const list = (Array.isArray(units) ? units : []).filter((u) => u && typeof u.id === "string" && typeof u.name === "string" && u.name.trim() !== "");
  const limit = Number.isFinite(opts?.limitPerUnit) ? Math.max(1, Math.floor(Number(opts.limitPerUnit))) : 8;
  const stems = new Map<string, NameStem>();
  for (const u of list) stems.set(u.id, stemOf(u.name));

  const out: UnitRelation[] = [];
  const perUnit = new Map<string, number>();
  const bump = (id: string): boolean => {
    const n = (perUnit.get(id) ?? 0) + 1;
    perUnit.set(id, n);
    return n <= limit;
  };

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      const sa = stems.get(a.id)!;
      const sb = stems.get(b.id)!;
      if (sa.stem === "" || sb.stem === "") continue;

      const shared = sharesAvatar(a.avatarIds, b.avatarIds);
      const sameName = sa.normName !== "" && sa.normName === sb.normName;
      const sameStem = sa.stem === sb.stem;
      if (sameName && !sa.stripped && !sb.stripped && sameStem) continue; // 同一单元的重复条目，不是关系

      // 伴生素材**优先**：主干相同且至少一侧削掉了"材质/贴图/模型"后缀。
      // 必须先于 optional_variant —— 否则同 avatar 的 MODEL/MATERIAL/TEXTURE 三件套会全部被判成
      // 同名变体（verifier P-6：stem 与 avatar 都相同 → optional 分支先命中，companion 不可达）。
      if (sameStem && (sa.stripped || sb.stripped) && !sameName) {
        if (!bump(a.id) || !bump(b.id)) continue;
        out.push({
          from: a.id, to: b.id, type: "suggested_companion", confidence: "probable",
          evidence: "名称主干相同（模型/材质/贴图伴生）：" + a.name + " / " + b.name,
        });
        continue;
      }
      // 只有不满足伴生条件时：同 avatar + 同一主干（版本尾巴不同）→ 可选变体
      if (shared !== null && sa.variantKey === sb.variantKey && (!sameName || !sameStem)) {
        if (!bump(a.id) || !bump(b.id)) continue;
        out.push({
          from: a.id, to: b.id, type: "optional_variant", confidence: "probable",
          evidence: "同模型 avatar#" + shared + " 的同名变体：" + a.name + " / " + b.name,
        });
      }
    }
  }
  return out.sort((x, y) => (x.from === y.from ? (x.to < y.to ? -1 : x.to > y.to ? 1 : 0) : x.from < y.from ? -1 : 1));
}
