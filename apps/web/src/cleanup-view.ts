/**
 * 整理待办展示层纯函数（P4-T4；cleanup-todos spec §6.1/§6.2/§6.3/§7.2）。
 *
 * 只做文案与形状换算：不发请求、不读 DOM、不改入参。
 * 口径纪律：
 * - counts 是「规则命中计数」（除 rule/ignored 外的筛选生效；ignored 不影响），
 *   与当前列表 total（分页口径）不是一回事；counts.<rule>.ignored 只是当前命中行中的子集。
 * - resolved 只在忽略行上求值：true=问题当前不存在，false=问题当前存在；普通待办行恒为 null。
 * - missing_file 是库内标记（上次扫描/确认），不是实时磁盘检查。
 * - local 策略必选、无服务端默认；主 UI 默认 include_local（用户 m00868 已准）。
 */
import type {
  CleanupFilter, CleanupRule, CleanupTodosResponse, LocalSourcePolicy,
} from "./types";

/** 四类规则（顺序即 tab 顺序；服务端 CLEANUP_RULES 同序）。 */
export const CLEANUP_RULES: readonly CleanupRule[] = ["missing_cover", "missing_source", "unlinked_model", "missing_file"];

/** 主 UI 默认策略：用户 m00868 已准 include_local；下拉无「未选」态。 */
export const DEFAULT_LOCAL_POLICY: LocalSourcePolicy = "include_local";

/** missing_file 行的固定提示：库内标记，不是实时磁盘检查。 */
export const MISSING_FILE_NOTE = "库内标记为缺失（来自上次扫描/确认），不是实时磁盘检查";

const RULE_LABEL: Record<CleanupRule, string> = {
  missing_cover: "缺封面",
  missing_source: "缺来源",
  unlinked_model: "未关联模型",
  missing_file: "文件失联",
};

/** 规则文案（spec §7.2 固定四类）。 */
export function ruleLabel(r: CleanupRule): string {
  return RULE_LABEL[r];
}

/** resolved 文案；null（普通待办行）不冒充已解决/未解决，返回空串。 */
export function resolvedLabel(resolved: boolean | null): string {
  if (resolved === true) return "问题当前不存在";
  if (resolved === false) return "问题当前存在";
  return "";
}

/** counts 形状：服务端实际 DTO 含 total；旧类型未声明 total，这里按可选兼容。 */
export type CleanupCounts = CleanupTodosResponse["counts"] & { total?: number };

/**
 * 四类计数文案：每类 total（已忽略子集）+ 合计 + 被排除 local 数。
 * 明确写出「规则命中计数」与「已忽略是当前命中行中的子集」，避免把 counts 当列表 total。
 */
export function countsTotal(c: CleanupCounts): number {
  return typeof c.total === "number" ? c.total : CLEANUP_RULES.reduce((n, r) => n + c[r].total, 0);
}

export function countsCaption(c: CleanupCounts): string {
  const parts = CLEANUP_RULES.map((r) => ruleLabel(r) + " " + c[r].total + "（已忽略 " + c[r].ignored + "）");
  const sum = countsTotal(c);
  return parts.join(" · ")
    + " · 合计 " + sum + " 行（规则命中计数，不受「已忽略」筛选影响；已忽略数是当前命中行中的子集）"
    + " · 被排除 " + c.missing_source.localExcluded + " 条 local 条目（不是待办）";
}

/** 行证据文案：按 rule 读真实字段；非 missing_cover 行不得盲读 imageCount。 */
export function evidenceText(row: CleanupTodoRowLike): string {
  switch (row.rule) {
    case "missing_cover":
      return "库内图片 " + row.evidence.imageCount + " 张";
    case "missing_source":
      return "来源站点 " + row.evidence.sourceSite + "；source_gone=" + row.evidence.sourceGone;
    case "unlinked_model":
      return "条目关联模型 " + row.evidence.itemAvatarCount + " 个；资产关联模型 " + row.evidence.assetAvatarCount + " 个";
    case "missing_file":
      return "缺失资产 " + row.evidence.missingAssetCount + " 个";
  }
}

/** 只取 evidenceText 需要的判别字段，避免把整行 DTO 绑进纯函数签名。 */
export type CleanupTodoRowLike =
  | { rule: "missing_cover"; evidence: { imageCount: number } }
  | { rule: "missing_source"; evidence: { sourceSite: string; sourceGone: number } }
  | { rule: "unlinked_model"; evidence: { itemAvatarCount: number; assetAvatarCount: number } }
  | { rule: "missing_file"; evidence: { missingAssetCount: number } };

/** UI 列表状态（todos 查询与保存筛选的共同来源）。 */
export interface CleanupListState {
  rule?: CleanupRule | null;
  q?: string;
  avatarIds?: number[];
  categoryIds?: string[];
  ignored?: "hide" | "show" | "only";
  sort?: "updated" | "title";
  localSourcePolicy: LocalSourcePolicy;
  limit?: number;
  offset?: number;
}

/**
 * 保存筛选 JSON：用服务端实际键（avatarIds/categoryIds/localSourcePolicy），
 * 不是 query 的 avatar/category CSV；offset 不属于 filter；空值不写。
 */
export function filterBody(s: CleanupListState): CleanupFilter {
  const out: CleanupFilter = { localSourcePolicy: s.localSourcePolicy };
  if (s.rule) out.rule = s.rule;
  const q = (s.q ?? "").trim();
  if (q) out.q = q;
  if (s.avatarIds && s.avatarIds.length > 0) out.avatarIds = [...s.avatarIds];
  if (s.categoryIds && s.categoryIds.length > 0) out.categoryIds = [...s.categoryIds];
  if (s.ignored) out.ignored = s.ignored;
  if (s.sort) out.sort = s.sort;
  if (s.limit !== undefined) out.limit = s.limit;
  return out;
}

/** 应用保存筛选：恢复成 UI 状态；策略必选、offset 归零、缺省值按 UI 默认。 */
export function savedFilterToState(f: CleanupFilter): CleanupListState {
  return {
    rule: f.rule ?? null,
    q: f.q ?? "",
    avatarIds: f.avatarIds ? [...f.avatarIds] : [],
    categoryIds: f.categoryIds ? [...f.categoryIds] : [],
    ignored: f.ignored ?? "hide",
    sort: f.sort ?? "updated",
    localSourcePolicy: f.localSourcePolicy,
    limit: f.limit ?? 50,
    offset: 0,
  };
}
