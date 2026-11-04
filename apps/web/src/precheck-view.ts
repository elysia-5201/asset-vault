/**
 * 预检卡纯函数（import-precheck spec §6.1 / §8.1）。
 *
 * 只做展示派生：标签、优先级、弱提示文案、expected 构造、冲突/候选文案。
 * 不读网络、不读 DOM、不写状态。文案禁止「已验证版本 / 确认是新版本 / 实时磁盘检查」：
 * 版本候选一律写「未证实 / 需人工确认」，弱提示一律写「不是精确重复」。
 */
import type { AcceptedFilePayload, PrecheckExpected } from "./api";
import type { PrecheckResult } from "./types";

export type PrecheckSummary = PrecheckResult["summary"];

/** spec §8.1 的固定标签。pathCollision 的具体条目号由 pathCollisionText 补。 */
const LABELS: Record<PrecheckSummary, string> = {
  exact: "精确重复（字节相同）",
  "version-candidate": "同商品，可能是新版本（未证实）",
  "companion-candidate": "同商品，可能是配套文件（未证实）",
  "same-product": "同商品",
  pathCollision: "路径已属于其它条目",
  weak: "弱提示（不是精确重复）",
  unknown: "未知（哈希失败/超预算/已取消）",
  none: "未发现重复",
};

const UNKNOWN_LABEL = "未知（哈希失败/超预算/已取消）";

export function summaryLabel(s: PrecheckSummary): string {
  return LABELS[s] ?? UNKNOWN_LABEL;
}

/**
 * 排序优先级，严格按 spec §6.1：
 * exact > version-candidate > companion-candidate > same-product > pathCollision > weak > unknown > none。
 */
const PRIORITY: Record<PrecheckSummary, number> = {
  exact: 100,
  "version-candidate": 90,
  "companion-candidate": 80,
  "same-product": 70,
  pathCollision: 60,
  weak: 40,
  unknown: 20,
  none: 0,
};

export function summaryPriority(s: PrecheckSummary): number {
  return PRIORITY[s] ?? 0;
}

/** 弱提示原因 → 文案；四种原因都必须写明「不是精确重复」（spec §7.2）。 */
const WEAK_TEXT: Record<string, string> = {
  name_size_hint: "弱提示：同名同尺寸（不是精确重复）",
  existing_hash_stale: "弱提示：库内哈希已陈旧（不是精确重复）",
  existing_hash_unverified: "弱提示：库内哈希未验证（不是精确重复）",
  existing_hash_mismatch: "弱提示：库内哈希不一致（不是精确重复）",
};

/** 弱提示优先；没有弱提示时回落到服务端 warnings（原样拼接，不改写）。 */
export function warningText(r: PrecheckResult): string {
  const weak = r?.match?.weak;
  if (weak) return WEAK_TEXT[weak.reason] ?? "弱提示（不是精确重复）";
  const warnings = Array.isArray(r?.warnings) ? r.warnings.filter((w) => typeof w === "string" && w !== "") : [];
  return warnings.join("；");
}

/**
 * 失败行（哈希失败/超预算/取消）可能没有 size/mtime —— 返回 null，绝不假造 0 或空串：
 * 服务端对缺 expected 的 files 项直接 400 EXPECTED_REQUIRED，这是结构性保证。
 */
export function expectedOf(r: PrecheckResult): PrecheckExpected | null {
  const size = r?.size;
  const mtime = r?.mtime;
  if (typeof size !== "number" || !Number.isFinite(size)) return null;
  if (typeof mtime !== "string" || mtime === "") return null;
  const out: PrecheckExpected = { size, mtime };
  const hash = r?.hash;
  if (hash && hash.state === "ok" && typeof hash.sha256 === "string" && hash.sha256 !== "") out.sha256 = hash.sha256;
  return out;
}

export function acceptedFileOf(r: PrecheckResult): AcceptedFilePayload | null {
  const expected = expectedOf(r);
  if (!expected) return null;
  const path = typeof r?.path === "string" ? r.path : "";
  if (!path) return null;
  const out: AcceptedFilePayload = { path, expected };
  const group = r?.group;
  if (group && typeof group.rootPath === "string") out.group = { rootPath: group.rootPath, rootId: group.rootId ?? null };
  return out;
}

/** 路径冲突文案：DTO 没有 title，只写真实 id，不编造标题。 */
export function pathCollisionText(m: PrecheckResult["match"]["pathCollision"]): string {
  if (!m) return "";
  const head = "路径已属于 #" + m.itemId + "（资产 #" + m.assetId + "）";
  return m.sameItem ? head + "：同一条目同一路径，导入幂等" : head + "：跳过，或去该条目走既有合并入口";
}

/** 版本候选文案：只陈述候选依据与键，不声称已证实。 */
export function versionCandidateText(v: PrecheckResult["match"]["version"]): string {
  if (!v) return "";
  const basis = v.basis === "filename" ? "文件名" : "标题";
  const incoming = v.incomingKey ?? "未知";
  const existing = v.existingKey ?? "未知";
  return "候选版本关系（需人工确认）：按" + basis + " " + incoming + " → " + existing + "，未证实";
}
