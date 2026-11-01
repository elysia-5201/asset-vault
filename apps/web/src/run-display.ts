/**
 * 工作台展示语义（纯函数，可单测）：run 结论 / 计划徽章 tone / GUID 计数文案 / 控制台原因。
 *
 * 三条纪律：
 * 1. 「计划已执行（executed）」只表示导入命令已发、验证阶段已收尾，**不等于验证通过**；
 *    计划徽章的 tone 在 executed 时必须由同一 plan 的最近 run 派生。
 * 2. 单元数（total/verified/partial_success/...）与 GUID 数（checked/expected/found/missing）**分开**展示。
 * 3. 后端没给的数字是未知（null），展示成「未提供」，绝不写成 0；显式 0 保留；sampled 不得声称全量。
 */
import type { PlanLatestRun, RunCounts, VerificationStats } from "./types";

export type Tone = "ok" | "warn" | "bad" | "busy" | "muted" | "violet" | "";

/** run 状态 → 中文（后端 import_runs.status 原值，不新增状态）。 */
export const RUN_STATE_LABEL: Record<string, string> = {
  planned: "待执行",
  running: "执行中",
  importing: "导入中",
  import_command_completed: "导入命令已完成",
  verifying: "校验中",
  verified: "验证通过",
  partial_success: "部分成功",
  failed: "失败",
  unknown: "结果未知",
  cancelled: "已取消",
  interrupted: "已中断",
};
export const RUN_STATE_TONE: Record<string, Tone> = {
  planned: "muted", running: "busy", importing: "busy", import_command_completed: "busy", verifying: "busy",
  verified: "ok", partial_success: "warn", failed: "bad", unknown: "warn", cancelled: "muted", interrupted: "warn",
};

export const VERIFICATION_SCOPE_LABEL: Record<string, string> = {
  full: "全量校验", all: "全量校验", sampled: "抽样校验",
};

/** GUID 存在性的边界说明（不得被读成「资产可用」）。 */
export const GUID_SCOPE_NOTE = "GUID 命中只说明工程里有对应 .meta，不代表类型、引用（PPtr）完整或功能可用";

const SCOPE_UNKNOWN = "校验范围未知";
const UNSET = "未提供";

function numText(n: number | null | undefined): string { return n === null || n === undefined ? UNSET : String(n); }

/**
 * verification_scope + checked/expected/found/missing → 一行可读文案。
 * 计数未知显示「未提供」；sampled 追加「不是全量」的限定。
 */
export function verificationText(v: VerificationStats | null | undefined): string {
  if (!v) return "";
  const hasAny = v.scope !== "" || v.checked !== null || v.expected !== null || v.found !== null || v.missing !== null;
  if (!hasAny) return "";
  const scope = VERIFICATION_SCOPE_LABEL[v.scope] ?? (v.scope || SCOPE_UNKNOWN);
  let s = scope + "：已查 " + numText(v.checked) + "/" + numText(v.expected)
    + "，命中 " + numText(v.found) + "，缺失 " + numText(v.missing);
  if (v.scope === "sampled") s += "（抽样：只核对了部分 GUID，不是全量）";
  return s;
}

/** 单元计数一行（与 GUID 覆盖分开写）。 */
export function runCountsText(c: RunCounts | null | undefined): string {
  if (!c) return "";
  return "单元 " + numText(c.total) + "：已校验 " + numText(c.verified) + "，部分成功 " + numText(c.partialSuccess)
    + "，失败 " + numText(c.failed) + "，未知 " + numText(c.unknown) + "，已取消 " + numText(c.cancelled);
}

/** 控制台 error 条数 + GUID 缺失数（都不冒充 0）。 */
export function consoleErrorCauseText(errors: string[] | null | undefined, missing: number | null | undefined): string {
  const head = errors === null || errors === undefined ? "控制台未提供" : "控制台 error " + errors.length + " 条";
  const tail = missing === null || missing === undefined ? "GUID 缺失未提供"
    : missing > 0 ? "GUID 缺失 " + missing + " 个" : "GUID 缺失 0 个";
  return head + "；" + tail;
}

export interface RunVerdict {
  key: "verified" | "partial" | "failed" | "unknown" | "cancelled" | "inflight" | "none" | "other";
  label: string;
  tone: Tone;
}

/** run 结论：verified/partial/failed/unknown 分别清楚；无 run 保守未知，不当通过。 */
export function runVerdictOf(status: string | null | undefined): RunVerdict {
  const s = status ?? "";
  if (s === "verified") return { key: "verified", label: "验证通过", tone: "ok" };
  if (s === "partial_success") return { key: "partial", label: "部分成功（未通过验证）", tone: "warn" };
  if (s === "failed") return { key: "failed", label: "失败", tone: "bad" };
  if (s === "unknown") return { key: "unknown", label: "结果未知（可能已产生副作用）", tone: "warn" };
  if (s === "cancelled") return { key: "cancelled", label: "已取消", tone: "muted" };
  if (["planned", "running", "importing", "import_command_completed", "verifying"].includes(s)) {
    return { key: "inflight", label: RUN_STATE_LABEL[s] ?? "执行中", tone: "busy" };
  }
  if (!s) return { key: "none", label: "验证状态未知（无执行记录）", tone: "muted" };
  return { key: "other", label: RUN_STATE_LABEL[s] ?? s, tone: "muted" };
}

/** 计划状态 → 中文（executed 只说「已执行」）。 */
export const PLAN_STATE_LABEL: Record<string, string> = {
  ready: "待执行", running: "执行中", executed: "已执行", failed: "失败", blocked: "预检受阻",
  unknown: "结果未知", cancelled: "已取消",
};

/**
 * 计划徽章 tone：executed 必须由同一 plan 的最近 run 派生，不能恒绿；
 * 其它状态沿用后端语义。
 */
export function planToneOf(plan: { state: string; latestRun: PlanLatestRun | null }): Tone {
  switch (plan.state) {
    case "executed": return runVerdictOf(plan.latestRun?.status ?? "").tone;
    case "ready": return "warn";
    case "running": return "busy";
    case "failed": return "bad";
    case "blocked": return "bad";
    case "unknown": return "warn";
    default: return "muted";
  }
}
