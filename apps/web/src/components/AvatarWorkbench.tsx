import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizePath } from "@core/pathnorm";
import {
  analyzeWorkbenchItem, confirmImportPlan, createImportPlans, describeError, executeImportPlan, getImportPlan, getImportRun,
  getJob, listImportPlans, mediaUrl, scanAllWorkbench, unityStatus, workbenchAvatars, workbenchItems, type UnityStatusWeb,
} from "../api";
import type { ImportPlan, PlanLatestRun, ImportRun, WorkbenchAvatar, WorkbenchItem } from "../types";
import { mapFocusToUnits, sameSlot, type WorkbenchFocus } from "../workbench-focus";
import { defaultLoadoutPackage, loadLoadoutPackages, type LoadoutPackages, type LoadoutWorkbenchScope } from "../loadout-workbench";
import {
  GUID_SCOPE_NOTE, PLAN_STATE_LABEL, RUN_STATE_TONE, VERIFICATION_SCOPE_LABEL, consoleErrorCauseText, planToneOf,
  runCountsText, runVerdictOf, verificationText,
} from "../run-display";
import { formatDate, shortenPath } from "../util";
import { Badge, Spinner, useDebounced } from "./ui";

// 计划/校验的文案与 tone 规则放在纯函数模块（run-display）里，这里原样再导出，保持既有调用方/smoke 不变。
export { PLAN_STATE_LABEL, VERIFICATION_SCOPE_LABEL, verificationText };

/** 互斥槽位规则在 workbench-focus（纯函数，可单测）里；这里原样再导出，保持既有调用方/smoke 不变。 */
export { sameSlot } from "../workbench-focus";

/**
 * Avatar 素材工作台（task-39）。
 *
 * 定位：面向「这个 Avatar 我要导入哪些素材」的一次性工作台 —— 选 Avatar → 看证据/策略 →
 * 勾选进「导入清单」→ 选 Unity 工程 → 生成**导入计划**（只读预检）→ 确认 → 轮询每单元执行状态。
 *
 * 纪律：
 * - **不自造第二套状态**：计划/执行状态全部来自后端（planned / importing / import_command_completed /
 *   verifying / verified / partial_success / failed / unknown），这里只做标签与配色映射、原样展示。
 * - **suggested 不默认入计划**：建议项一律未勾选，必须用户显式勾选才会进入 confirm 的 unitIds。
 * - **mixed 必须显式警告**：混合整包会把其它 Avatar 的资源一起导入，卡片与计划两处都要提示。
 * - 选择冲突仅涉及互斥变体或重复包路径，一个归档里的独立包可以一起导入。
 */

type Tone = "ok" | "warn" | "bad" | "busy" | "muted" | "violet" | "";

/** 混合整包风险文案（前后端可能各自给；前端兜底文案就在这里，smoke 断言它）。 */
export const MIXED_WARNING = "混合整包：将完整导入，其他 Avatar 的资源也可能被一并导入";

/** policy 字面量与后端 asset_units.policy 一致（旧值保留映射，读到就原样显示）。 */
export const POLICY_LABEL: Record<string, string> = {
  single_unitypackage: "独立包",
  mixed_unitypackage: "混合整包",
  unknown_structure: "结构未知",
  standalone: "独立包", multi_package: "多包容器", mixed: "混合整包", unknown: "策略未知",
};
export const LEVEL_LABEL: Record<string, string> = {
  confirmed: "已确认", probable: "可能", unknown: "未知",
  strong: "强证据", weak: "弱证据", none: "无证据",
};
export const LEVEL_TONE: Record<string, Tone> = {
  confirmed: "ok", probable: "busy", unknown: "muted",
  strong: "busy", weak: "warn", none: "muted",
};
/** 执行单元状态 → 中文。键集合与后端契约一致，不增不减。 */
export const UNIT_STATE_LABEL: Record<string, string> = {
  planned: "待执行",
  importing: "导入中",
  import_command_completed: "导入命令已完成",
  verifying: "校验中",
  verified: "已校验",
  partial_success: "部分成功",
  failed: "失败",
  unknown: "未知",
  cancelled: "已取消",
  // 计划项（import_plan_items.status）也用同一张表；不新增状态，只是给后端已有值配文案
  pending: "待导入",
  suggested: "建议（待确认）",
};
export const UNIT_STATE_TONE: Record<string, Tone> = {
  planned: "muted", importing: "busy", import_command_completed: "busy",
  verifying: "busy", verified: "ok", partial_success: "warn", failed: "bad", unknown: "warn", cancelled: "muted",
};

// PLAN_STATE_LABEL 由 run-display 提供（executed = 「已执行」，不等于验证通过）；这里只保留终态常量。
/** 计划的终态（**只用于决定停止轮询**；值来自后端，不新增状态）。 */
const PLAN_TERMINAL_STATES = ["executed", "failed", "blocked"];

// ---------------- 风险/校验（v0.7.1 导入可靠性） ----------------
/** 风险状态文案（后端 risk_state：clear/warning/blocked/unknown）。 */
export const RISK_LABEL: Record<string, string> = {
  clear: "风险扫描通过", warning: "有风险提示（需确认）", blocked: "禁止执行", unknown: "风险未知（需确认）",
};
export const RISK_TONE: Record<string, Tone> = {
  clear: "ok", warning: "warn", blocked: "bad", unknown: "warn",
};
/** 最多展示多少条命中（更多只给"还有 N 条"）。 */
export const RISK_HIT_LIMIT = 20;
/** unknown 执行状态必须给出的警告文案（不自动重试）。 */
export const UNKNOWN_STATE_HINT = "结果未知：可能已产生副作用，请先在 Unity 工程中核对，不要直接重试";
// verificationText / VERIFICATION_SCOPE_LABEL 由 run-display 提供（计数未知 = 「未提供」，不是 0）。
/** 只有 failed 的计划才允许重建（unknown 必须先人工核对）。 */
export function canRebuildPlan(state: string): boolean { return state === "failed"; }

/** 仍在推进的单元状态（**只用来决定要不要继续轮询**，不是状态机、不推断转移）。 */
const IN_FLIGHT_UNIT_STATES = ["planned", "importing", "import_command_completed", "verifying"];
export function isRunBusy(run: ImportRun | null): boolean {
  return !!run && run.units.some((u) => IN_FLIGHT_UNIT_STATES.includes(u.state));
}

/** 勾选/取消勾选（互斥在「勾选新项」时生效：同槽位的旧项会被替换掉；不可导入的单元一律拒绝）。 */
export function togglePick(plan: WorkbenchItem[], unit: WorkbenchItem): WorkbenchItem[] {
  if (plan.some((u) => u.unitId === unit.unitId)) return plan.filter((u) => u.unitId !== unit.unitId);
  if (!unit.importable) return plan;
  const rest = plan.filter((u) => !sameSlot(u, unit));
  return [...rest, unit];
}

/** 清单里任意一项是 mixed → 需要显示整包风险。 */
export function anyMixed(units: { mixed: boolean }[]): boolean {
  return units.some((u) => u.mixed);
}

/** 空态按钮文案（smoke 断言用）。 */
export const SCAN_ALL_LABEL = "扫描全部结构";

/**
 * Avatar 列表为空时的兜底：用 Unity 工程里认出的 projectAvatar 造一条伪 Avatar。
 * 起因：/workbench/avatars 只返回「有条目单元证据」的头像；工程里已识别的头像可能还没扫过结构，
 * 于是左侧空空、用户以为探测失败。
 */
export function fallbackAvatarOf(pa: { id: number; name: string }): WorkbenchAvatar {
  return {
    id: pa.id, name: pa.name, kind: null, owned: 0, coverPath: null,
    counts: { total: 0, confirmed: 0, probable: 0, unknown: 0, mixed: 0 },
  };
}

/** 选中规则：列表非空用列表第一条；列表为空但有 Unity 兜底头像就用它。 */
export function pickAvatarId(list: { id: number }[], fallback: { id: number } | null | undefined): number | null {
  if (list.length) return list[0].id;
  return fallback ? fallback.id : null;
}

/** units=0 的空态：解释 + 「扫描全部结构」按钮（导出以便 SSR/单测断言）。 */
export function UnitsEmptyState(props: {
  scanning: boolean;
  onScanAll: () => void;
  avatarName?: string | null;
  fallbackFromUnity?: boolean;
}) {
  return (
    <div className="empty" style={{ display: "flex", flexDirection: "column", gap: "6px", alignItems: "center" }}>
      <div>{props.avatarName ? "@" + props.avatarName + " 名下还没有资源单元" : "还没有资源单元"}</div>
      <div className="hint">
        {props.fallbackFromUnity
          ? "这个 Avatar 是从 Unity 工程里认出来的，库里还没分析过它的素材结构。"
          : "先对条目做一次结构分析（容器 / 单元识别），分析完这里就会出现可勾选的单元。"}
      </div>
      <button className="btn primary" onClick={props.onScanAll} disabled={props.scanning}>
        {props.scanning ? "扫描中…" : SCAN_ALL_LABEL}
      </button>
      <div className="hint">只补还没分析过的条目（onlyMissing=true）</div>
    </div>
  );
}

/**
 * 计划面板（纯展示，导出供 smoke 直接渲染）。
 * suggested 单元默认不勾选；checks 由父组件持有（confirm 时只发勾选的 unitId）。
 */
export function PlanPanel(props: {
  plan: ImportPlan;
  checks: Record<string, boolean>;
  onToggle: (unitId: string) => void;
  onConfirm: () => void;
  busy: boolean;
  /** 提交执行后拿到的 job 号（202 {jobId, planId}），仅展示。 */
  jobId?: number | null;
  /** 风险提示（warning / unknown）是否已被用户显式确认 */
  riskAck?: boolean;
  onRiskAck?: (v: boolean) => void;
  /** 只有 failed 的计划才允许重建（由父组件判定/传入） */
  onRebuild?: () => void;
}) {
  const { plan } = props;
  const units = plan.units;
  const checkedCount = units.filter((u) => props.checks[u.unitId]).length;
  const suggestedCount = units.filter((u) => u.suggested).length;
  const mixedWarning = plan.mixedWarning ?? (anyMixed(units) ? MIXED_WARNING : "");
  // 风险扫描：blocked 禁止执行（不提供强制按钮）；warning / unknown 必须显式确认
  const risk = plan.risk;
  const riskState = risk?.state ?? "";
  const riskBlocked = riskState === "blocked" || plan.state === "blocked";
  const needsRiskAck = riskState === "warning" || riskState === "unknown";
  const ackMissing = needsRiskAck && !props.riskAck;
  const canConfirm = !riskBlocked && !ackMissing && checkedCount > 0;
  const hits = (risk?.hits ?? []).slice(0, RISK_HIT_LIMIT);
  const restHits = (risk?.hits?.length ?? 0) - hits.length;
  const ver = plan.verification;

  return (
    <div className="section" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div className="row" style={{ gap: "6px" }}>
        <b>导入计划 #{plan.id}</b>
        {plan.itemId !== null && plan.itemId !== undefined ? <span className="hint mono">条目 #{plan.itemId}</span> : null}
        {plan.state ? <Badge tone={planToneOf(plan)} title={plan.state}>{PLAN_STATE_LABEL[plan.state] ?? plan.state}</Badge> : null}
        {riskState ? <Badge tone={RISK_TONE[riskState] ?? "muted"} title={"risk_state=" + riskState}>{RISK_LABEL[riskState] ?? riskState}</Badge> : null}
        <Badge tone={plan.precheck.ok ? "ok" : "warn"}>{plan.precheck.ok ? "预检通过" : "预检有警告"}</Badge>
        {props.jobId !== null && props.jobId !== undefined ? <span className="hint mono">job #{props.jobId}</span> : null}
        <span className="spacer" />
        <span className="hint">已勾选 {checkedCount}/{units.length}</span>
      </div>
      {/* 「已执行」只表示导入命令已发/验证收尾；结论必须来自同一 plan 的最近 run，没有就保守未知 */}
      {plan.state === "executed" || plan.latestRun ? <PlanLatestRunBlock plan={plan} /> : null}
      {plan.precheck.errors.map((e, i) => (
        <div className="err" key={"pe" + i}>{e.code}：{e.message}</div>
      ))}
      {plan.precheck.warnings.map((w, i) => (
        <div className="notice" key={"pw" + i}>{w}</div>
      ))}

      {/* 风险扫描：状态 + 命中文件 + 扫描范围/截断 + 显式确认 */}
      {riskState ? (
        <div className={riskBlocked ? "err" : "notice"} data-risk={riskState}>
          <div className="row" style={{ gap: "6px" }}>
            <b>{RISK_LABEL[riskState] ?? riskState}</b>
            <span className="hint">
              扫描范围 {risk.scan.scope ?? "未提供"}
              {risk.scan.truncated ? "（已截断）" : ""}
              {risk.scan.files !== null ? " · 文件 " + risk.scan.files : ""}
              {risk.scan.dirs !== null ? " · 目录 " + risk.scan.dirs : ""}
            </span>
          </div>
          {hits.length > 0 && (
            <div className="preview-list" style={{ maxHeight: "16vh", marginTop: "4px" }}>
              {hits.map((h, i) => (
                <div key={i} className="row" style={{ gap: "6px", padding: "2px 6px", fontSize: "11px" }}>
                  <span className="mono" style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={h.path}>{shortenPath(h.path, 64)}</span>
                  <span className="hint">{h.type}</span>
                  <span className="hint">{h.reason}</span>
                </div>
              ))}
            </div>
          )}
          {restHits > 0 && <div className="hint">还有 {restHits} 条命中未显示（最多列 {RISK_HIT_LIMIT} 条）</div>}
          {riskBlocked && <div className="hint">blocked：只显示原因，不提供强制执行按钮。</div>}
          {needsRiskAck && (
            <label className="chk" style={{ marginTop: "4px" }}>
              <input type="checkbox" checked={!!props.riskAck} onChange={(e) => props.onRiskAck?.(e.target.checked)} />
              我已核对上面的风险命中（warning / unknown 必须显式确认后才能执行）
            </label>
          )}
        </div>
      ) : (
        <div className="hint">未提供风险扫描（后端 risk_state 缺失，不当作 clear）</div>
      )}

      {mixedWarning ? (
        <div className="err" data-warning="mixed">
          {mixedWarning}
        </div>
      ) : null}
      <div className="preview-list" style={{ maxHeight: "24vh" }}>
        {units.map((u) => (
          <label className="row" key={u.unitId} style={{ gap: "6px", padding: "4px 7px", borderBottom: "1px solid var(--line-soft)", fontSize: "12px", cursor: "pointer", alignItems: "center" }}>
            <input
              type="checkbox"
              checked={!!props.checks[u.unitId]}
              onChange={() => props.onToggle(u.unitId)}
            />
            <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={u.packagePath ?? u.title}>{u.title}</span>
            {u.suggested && <Badge tone="violet">建议</Badge>}
            {u.mixed && <Badge tone="bad">整包</Badge>}
            <span className="hint">{POLICY_LABEL[u.policy] ?? u.policy}</span>
            {u.error && <span className="err-text" style={{ fontSize: "11px" }}>{u.error.code}: {u.error.message}</span>}
          </label>
        ))}
        {!units.length && <div className="hint" style={{ padding: "8px" }}>计划里没有单元</div>}
      </div>
      {ver ? <div className="hint mono">校验覆盖度 — {verificationText(ver)}</div> : null}
      <div className="row" style={{ gap: "6px" }}>
        <button className="btn primary" disabled={props.busy || !canConfirm} onClick={props.onConfirm}
          title={riskBlocked ? "blocked：禁止执行" : ackMissing ? "先确认风险提示" : "confirm → execute"}>
          {props.busy ? <Spinner /> : null}确认并导入 {checkedCount} 个单元
        </button>
        {canRebuildPlan(plan.state) && props.onRebuild ? (
          <button className="btn" disabled={props.busy} onClick={props.onRebuild} title="failed 才允许重建；会新建计划，不覆盖旧计划">重建计划</button>
        ) : null}
        {suggestedCount > 0 && <span className="hint">「建议」项默认不勾选，需你确认后才加入</span>}
        {ackMissing && <span className="hint">先把上面的风险确认勾上</span>}
      </div>
    </div>
  );
}

/** 生成计划后的 toast 文案（按条目分组时点明个数；smoke 断言用）。 */
export function plansToastText(count: number, warnCount = 0): string {
  const base = "已生成 " + count + " 个计划（按条目分组）";
  return warnCount > 0 ? base + "，其中 " + warnCount + " 个预检有警告" : base;
}

/** 控制台消息最多展示多少条（其余只给条数）。 */
export const CONSOLE_MESSAGE_LIMIT = 20;

/** partial 的中文原因：只说能证的（缺失数 / 控制台条数），不猜根因。 */
export function partialReasonText(lr: PlanLatestRun | null): string {
  if (!lr) return "没有执行记录，无法确认是否验证通过";
  if (lr.status !== "partial_success") return "";
  const errs = lr.consoleErrors;
  const missing = lr.verification?.missing ?? null;
  if (errs && errs.length > 0 && missing === 0) return "原因：GUID 缺失为 0，但控制台 error 级条目非空";
  if (missing !== null && missing > 0) return "原因：GUID 缺失 " + missing + " 个";
  if (errs === null || missing === null) return "原因：控制台或 GUID 缺失计数未提供，无法进一步确认";
  return "原因：控制台有 error 级条目或 GUID 缺失，明细见上";
}

/** 控制台消息（可展开）—— 一律 React 文本，不用 dangerouslySetInnerHTML。 */
function ConsoleMessages(props: { errors: string[] | null | undefined }) {
  const errors = props.errors ?? [];
  if (!errors.length) return null;
  const shown = errors.slice(0, CONSOLE_MESSAGE_LIMIT);
  return (
    <details>
      <summary className="hint" style={{ cursor: "pointer" }}>展开查看控制台 error {errors.length} 条（点开看消息文本）</summary>
      <div className="preview-list" style={{ maxHeight: "18vh" }}>
        {shown.map((m, i) => (
          <div key={i} className="hint mono" style={{ padding: "2px 6px", wordBreak: "break-all" }}>{m}</div>
        ))}
      </div>
      {errors.length > shown.length ? <div className="hint">还有 {errors.length - shown.length} 条未显示</div> : null}
    </details>
  );
}

/** 计划卡上的「最近一次执行」：结论 / 单元计数 / GUID 覆盖 / 控制台原因，与「已执行」分开。 */
export function PlanLatestRunBlock(props: { plan: ImportPlan }) {
  const lr = props.plan.latestRun;
  const verdict = runVerdictOf(lr?.status ?? "");
  if (!lr) {
    return <div className="hint" data-run-verdict="none">最近执行：验证状态未知（无执行记录），「已执行」只代表导入命令已发</div>;
  }
  return (
    <div className="notice" data-run-verdict={verdict.key} style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
      <div className="row" style={{ gap: "6px" }}>
        <span className="hint">最近执行</span>
        <b className="mono">run #{lr.id}</b>
        <Badge tone={verdict.tone} title={"status=" + lr.status}>{verdict.label}</Badge>
        <span className="spacer" />
        <span className="hint">{formatDate(lr.startedAt)}{lr.finishedAt ? " → " + formatDate(lr.finishedAt) : ""}</span>
      </div>
      <div className="hint">{runCountsText(lr.counts)}</div>
      <div className="hint mono">{lr.verification ? "GUID 覆盖 — " + verificationText(lr.verification) : "GUID 覆盖：未提供"}</div>
      <div className="hint">{consoleErrorCauseText(lr.consoleErrors, lr.verification?.missing ?? null)}</div>
      {partialReasonText(lr) ? <div className="hint">{partialReasonText(lr)}</div> : null}
      <ConsoleMessages errors={lr.consoleErrors} />
      <div className="hint">{GUID_SCOPE_NOTE}</div>
    </div>
  );
}

/** 执行记录卡：中文结论 + 原始状态原样透传 + 单元/GUID 计数分开 + 控制台消息可查看。 */
export function RunCard(props: { run: ImportRun }) {
  const run = props.run;
  const verdict = runVerdictOf(run.state);
  const ver = run.verification;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }} data-run-verdict={verdict.key}>
      <div className="row" style={{ gap: "6px" }}>
        <b className="mono">run #{run.id}</b>
        {run.planId > 0 ? <span className="hint mono">计划 #{run.planId}</span> : null}
        <Badge tone={verdict.tone} title={"status=" + run.state}>{verdict.label}</Badge>
        <span className="hint mono">{run.state || "—"}</span>
        <span className="spacer" />
        <span className="hint">{formatDate(run.startedAt)}{run.finishedAt ? " → " + formatDate(run.finishedAt) : ""}</span>
      </div>
      {run.error && <div className="err">{run.error.code}：{run.error.message}</div>}
      {run.counts && run.counts.total !== null ? <div className="hint">{runCountsText(run.counts)}</div> : null}
      <div className="hint mono">{ver ? "GUID 覆盖 — " + verificationText(ver) : "GUID 覆盖：未提供"}</div>
      <div className="hint">{consoleErrorCauseText(run.consoleErrors, ver?.missing ?? null)}</div>
      {(run.state === "partial_success" || run.state === "unknown") ? (
        <div className="hint">{partialReasonText(run.counts ? { id: run.id, status: run.state, startedAt: run.startedAt, finishedAt: run.finishedAt, verification: ver, consoleErrors: run.consoleErrors, counts: run.counts } : null)}</div>
      ) : null}
      <ConsoleMessages errors={run.consoleErrors} />
      {(run.state === "unknown" || run.units.some((u) => u.state === "unknown")) && (
        <div className="err">{UNKNOWN_STATE_HINT}</div>
      )}
      {run.units.map((u) => (
        <div className="row" key={u.unitId} style={{ gap: "6px", alignItems: "flex-start" }}>
          <Badge tone={UNIT_STATE_TONE[u.state]}>{UNIT_STATE_LABEL[u.state] ?? u.state}</Badge>
          <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={u.title}>{u.title}</span>
          <span className="hint mono" style={{ flex: "0 0 auto" }}>{u.state}</span>
          {u.verification ? <span className="hint" style={{ flex: "0 0 auto" }} title={verificationText(u.verification)}>{verificationText(u.verification)}</span> : null}
          {u.consoleErrors && u.consoleErrors.length > 0 ? <span className="hint" style={{ flex: "0 0 auto" }}>控制台 error {u.consoleErrors.length} 条</span> : null}
          {u.error && <span className="err-text" style={{ flex: "0 0 auto" }}>{u.error.code}: {u.error.message}</span>}
        </div>
      ))}
      {!run.units.length && <div className="hint">这个 run 还没有单元</div>}
    </div>
  );
}

/**
 * 计划列表：**每个计划一个 PlanPanel**，各自勾选 / confirm / execute / 轮询。
 * 跨条目建计划时后端返回 {plans:[...]}（每 item 一个），这里逐条渲染并标注所属条目。
 */
export function PlansSection(props: {
  plans: ImportPlan[];
  checksFor: (p: ImportPlan) => Record<string, boolean>;
  onToggle: (planId: number, unitId: string) => void;
  onConfirm: () => void;
  busy: boolean;
  ackedJobs: Record<number, number>;
  /** planId → 风险提示是否已被显式确认（warning / unknown 必须勾） */
  riskAcks?: Record<number, boolean>;
  onRiskAck?: (planId: number, v: boolean) => void;
  /** failed 计划的重建入口 */
  onRebuild?: (plan: ImportPlan) => void;
}) {
  if (!props.plans.length) return null;
  return (
    <>
      <div className="hint">
        {props.plans.length > 1
          ? "④ 计划：按条目分成 " + props.plans.length + " 个，各自 confirm → execute，互不影响"
          : "④ 计划（suggested 需勾选才入计划）"}
      </div>
      {props.plans.map((p) => (
        <PlanPanel
          key={p.id}
          plan={p}
          checks={props.checksFor(p)}
          onToggle={(uid) => props.onToggle(p.id, uid)}
          onConfirm={props.onConfirm}
          busy={props.busy}
          jobId={props.ackedJobs[p.id] ?? p.jobId}
          riskAck={props.riskAcks ? props.riskAcks[p.id] === true : undefined}
          onRiskAck={(v) => props.onRiskAck?.(p.id, v)}
          onRebuild={props.onRebuild ? () => props.onRebuild!(p) : undefined}
        />
      ))}
    </>
  );
}

type WorkbenchPage = "pick" | "review" | "result" | "history";
type AnalysisJob = { id: number; itemId?: number };
type PlanBatch = Awaited<ReturnType<typeof createImportPlans>>;
const PAGE_SIZE = 120;

function packageTitle(unit: WorkbenchItem): string {
  return unit.packageName || unit.relPath || "包 #" + unit.unitId;
}

function needsAck(plan: ImportPlan): boolean {
  return plan.risk.state !== "clear" || anyMixed(plan.units);
}

function isBlocked(plan: ImportPlan): boolean {
  return !["ready", "needs_confirmation"].includes(plan.state)
    || !["clear", "warning", "unknown"].includes(plan.risk.state)
    || !plan.precheck.ok
    || !plan.units.length
    || plan.units.some((unit) => unit.state === "blocked" || unit.suggested);
}

export function recommendedPackages(units: WorkbenchItem[], avatarId: number | null): WorkbenchItem[] {
  if (avatarId === null) return [];
  return units.filter((u) => u.importable && !u.mixed && u.policy === "single_unitypackage"
    && (u.avatarMatches?.some((a) => a.id === avatarId && a.level === "confirmed")
      ?? (u.avatarId === avatarId && u.level === "confirmed"))
    && !units.some((other) => other.importable && other.unitId !== u.unitId && sameSlot(u, other)));
}

function RiskDetails({ plan }: { plan: ImportPlan }) {
  const blocked = isBlocked(plan);
  return <div className="wb-review-card">
    {blocked
      ? <Badge tone="bad">受阻</Badge>
      : needsAck(plan) ? <Badge tone="warn">需要确认</Badge> : <Badge tone="ok">检查通过</Badge>}
    {plan.units.map((unit) => (
      <div className="wb-package-note" key={unit.unitId} title={unit.packagePath ?? undefined}>
        <b>{unit.title}</b>
        {unit.relPath && <span className="hint mono">{unit.relPath}</span>}
        {unit.error && <span className="err-text">{unit.error.message}</span>}
      </div>
    ))}
    {anyMixed(plan.units) && <div className="notice">{MIXED_WARNING}</div>}
    {plan.risk.state === "warning" && <div className="notice">部分文件需要核对后才能导入。</div>}
    {plan.risk.state === "unknown" && <div className="notice">无法完整确认包内风险。</div>}
    {!plan.risk.state && <div className="err">没有收到风险检查结果，请重新检查。</div>}
    {plan.precheck.errors.map((error, i) => <div className="err" key={i}>{error.message}</div>)}
    {plan.precheck.warnings.map((warning, i) => <div className="notice" key={i}>{warning}</div>)}
    {plan.error && <div className="err">{plan.error.message}</div>}
    {plan.risk.hits.length > 0 && (
      <details open={blocked || undefined}>
        <summary>风险命中 {plan.risk.hits.length} 项</summary>
        {plan.risk.hits.slice(0, RISK_HIT_LIMIT).map((hit, i) => (
          <div className="wb-package-note" key={i}><span className="mono">{hit.path}</span><span className="hint">{hit.reason || hit.type}</span></div>
        ))}
        {plan.risk.hits.length > RISK_HIT_LIMIT && <p className="hint">此处显示前 {RISK_HIT_LIMIT} 项。</p>}
      </details>
    )}
    {blocked && <div className="hint">回到选包，移除受阻的包或修正文件后重新检查。</div>}
  </div>;
}

function ImportResult({ plan }: { plan: ImportPlan }) {
  const [run, setRun] = useState<ImportRun | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const { runId, latestRun } = plan;
  const lastStatus = latestRun?.status;
  useEffect(() => {
    if (!expanded || runId === null) return;
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await getImportRun(runId);
        if (active) { setRun(result); setError(""); }
      } catch (e) { if (active) setError(describeError(e)); }
      finally { pending = false; }
    };
    void refresh();
    const timer = PLAN_TERMINAL_STATES.includes(plan.state) ? null : setInterval(() => void refresh(), 1500);
    return () => { active = false; if (timer) clearInterval(timer); };
  }, [expanded, runId, lastStatus, plan.state]);
  const queued = plan.jobId !== null && !PLAN_TERMINAL_STATES.includes(plan.state) && !latestRun;
  const label = latestRun ? runVerdictOf(latestRun.status).label
    : queued ? "已提交，等待 Unity" : plan.state === "executed" ? "验证状态未知" : PLAN_STATE_LABEL[plan.state] ?? plan.state;
  return (
    <div className="section wb-result">
      <div className="wb-result-head">
        <b>{plan.itemTitle || (plan.units.length === 1 ? plan.units[0].title : plan.units.length + " 个导入包")}</b>
        <Badge tone={latestRun ? runVerdictOf(latestRun.status).tone : queued ? "busy" : planToneOf(plan)}>{label}</Badge>
      </div>
      <div className="hint wb-path">{plan.projectPath}{plan.createdAt && " · " + formatDate(plan.createdAt)}</div>
      {latestRun && <div className="hint">{runCountsText(latestRun.counts)}</div>}
      {plan.error && <div className="err">{plan.error.message}</div>}
      {latestRun && ["unknown", "interrupted"].includes(latestRun.status) && <div className="notice">{UNKNOWN_STATE_HINT}</div>}
      <details onToggle={(e) => setExpanded(e.currentTarget.open)}>
        <summary>查看各包与验证详情</summary>
        {plan.units.map((unit) => <div className="wb-package-note" key={unit.unitId}><b>{unit.title}</b>{unit.error && <span className="err-text">{unit.error.message}</span>}</div>)}
        {error && <div className="err">{error}</div>}
        {run?.id === runId && run && <RunCard run={run} />}
      </details>
    </div>
  );
}

export function AvatarWorkbench(props: {
  onClose: () => void;
  onToast: (kind: "ok" | "bad" | "info", text: string) => void;
  focus?: WorkbenchFocus | null;
  loadout?: LoadoutWorkbenchScope | null;
  projects?: { id: number; name: string; path: string }[];
  initialAvatarId?: number | null;
}) {
  const focus = props.focus ?? null;
  const loadout = props.loadout ?? null;
  const targetProject = loadout?.project;
  const [page, setPage] = useState<WorkbenchPage>("pick");
  const [focusOnly, setFocusOnly] = useState(!!focus);
  const [avatars, setAvatars] = useState<WorkbenchAvatar[]>([]);
  const [avatarId, setAvatarId] = useState<number | null>(props.initialAvatarId ?? null);
  const [query, setQuery] = useState("");
  const q = useDebounced(query, 250);
  const [offset, setOffset] = useState(0);
  const [units, setUnits] = useState<WorkbenchItem[]>([]);
  const [loadoutPackages, setLoadoutPackages] = useState<LoadoutPackages[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [revision, setRevision] = useState(0);
  const [analysis, setAnalysis] = useState<AnalysisJob | null>(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState("");
  const [picked, setPicked] = useState<WorkbenchItem[]>([]);
  const [conflict, setConflict] = useState<{ next: WorkbenchItem; previous: WorkbenchItem[] } | null>(null);
  const preferenceApplied = useRef(false);
  const loadoutDefaults = useRef(new Set<number>());
  const [editor, setEditor] = useState<UnityStatusWeb | null>(null);
  const [probing, setProbing] = useState(true);
  const [selectedProjectPath, setProjectPath] = useState("");
  const projectPath = targetProject?.path ?? selectedProjectPath;
  const [batch, setBatch] = useState<PlanBatch | null>(null);
  const [riskAck, setRiskAck] = useState(false);
  const [partialAck, setPartialAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [submitted, setSubmitted] = useState<ImportPlan[]>([]);
  const [submitErrors, setSubmitErrors] = useState<string[]>([]);
  const [history, setHistory] = useState<ImportPlan[]>([]);
  const [historyError, setHistoryError] = useState("");

  const editorPath = editor?.ok ? editor.editor?.projectPath : undefined;
  const matchesEditor = !!projectPath.trim() && !!editorPath && normalizePath(editorPath) === normalizePath(projectPath.trim());

  const probeUnity = useCallback(async () => {
    setProbing(true);
    try {
      const status = await unityStatus();
      setEditor(status);
      if (status.ok && status.editor?.projectPath) setProjectPath((path) => path || status.editor!.projectPath);
      return status;
    } catch {
      setEditor(null);
      return null;
    } finally { setProbing(false); }
  }, []);
  useEffect(() => { void probeUnity(); }, [probeUnity]);
  useEffect(() => {
    if (loadout) return;
    let alive = true;
    workbenchAvatars().then((list) => { if (alive) setAvatars(list); }).catch(() => {});
    return () => { alive = false; };
  }, [loadout, revision]);

  useEffect(() => {
    if (loadout) return;
    let alive = true;
    setLoading(true); setListError("");
    workbenchItems({
      itemId: focusOnly ? focus?.itemId : undefined,
      avatarId: focusOnly ? undefined : avatarId ?? undefined,
      q: q.trim() || undefined,
      limit: focusOnly ? 2000 : PAGE_SIZE + 1,
      offset: focusOnly ? 0 : offset,
    }).then(({ items }) => {
      if (!alive) return;
      setHasMore(!focusOnly && items.length > PAGE_SIZE);
      setUnits(focusOnly ? items : items.slice(0, PAGE_SIZE));
    }).catch((e) => {
      if (alive) { setUnits([]); setHasMore(false); setListError(describeError(e)); }
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [loadout, focus, focusOnly, avatarId, q, offset, revision]);

  useEffect(() => {
    if (!loadout) return;
    let alive = true;
    setLoading(true);
    void loadLoadoutPackages(loadout, () => alive).then((rows) => {
      if (!alive) return;
      const currentUnits = rows.flatMap((row) => row.units);
      const available = new Map(currentUnits.filter((unit) => unit.importable).map((unit) => [unit.unitId, unit]));
      const defaults = rows.flatMap((row) => {
        if (loadoutDefaults.current.has(row.id)) return [];
        const next = defaultLoadoutPackage(row, loadout.avatarId, currentUnits);
        if (!next) return [];
        loadoutDefaults.current.add(row.id);
        return [next];
      });
      setPicked((before) => {
        const next = before.flatMap((unit) => available.get(unit.unitId) ?? []);
        return [...next, ...defaults.filter((unit) => !next.some((other) => sameSlot(unit, other)))];
      });
      setConflict(null);
      setUnits(currentUnits);
      setLoadoutPackages(rows);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [loadout, revision]);

  useEffect(() => {
    if (!focus || !focusOnly || loading || probing || q || !units.length || preferenceApplied.current) return;
    const preferred = editor?.projectAvatar?.id ?? props.initialAvatarId ?? null;
    const mapped = new Set(focus.units.length ? mapFocusToUnits(focus, units).preselected : []);
    const candidates = focus.units.length ? units.filter((unit) => mapped.has(unit.unitId))
      : recommendedPackages(units, preferred);
    preferenceApplied.current = true;
    setPicked((existing) => existing.length ? existing : candidates.filter((unit) => unit.importable && !unit.mixed && unit.policy === "single_unitypackage"));
  }, [editor, focus, focusOnly, loading, probing, props.initialAvatarId, q, units]);

  async function launchAnalysis(itemId?: number) {
    setAnalysisBusy(true); setAnalysisStatus("");
    try {
      const response = itemId ? await analyzeWorkbenchItem(itemId, units.some((u) => u.itemId === itemId)) : await scanAllWorkbench(true);
      if (!response.jobId) throw new Error("结构分析没有返回作业编号");
      setAnalysis({ id: response.jobId, itemId });
      setAnalysisStatus("等待结构分析…");
    } catch (e) { setAnalysisStatus(describeError(e)); }
    finally { setAnalysisBusy(false); }
  }

  useEffect(() => {
    if (!analysis) return;
    let alive = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const job = await getJob(analysis.id);
        if (!alive) return;
        if (["done", "failed", "cancelled", "abandoned"].includes(job.state)) {
          setAnalysis(null);
          setAnalysisStatus(job.state === "done" ? "结构分析完成" : job.error || "结构分析未完成");
          setRevision((n) => n + 1);
        } else {
          setAnalysisStatus(job.state === "queued" ? "等待结构分析…" : "正在分析包内结构…");
        }
      } catch {
        if (alive) setAnalysisStatus("正在重新连接结构分析作业…");
      } finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [analysis]);

  useEffect(() => {
    if (page !== "history") return;
    let alive = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const recent = await listImportPlans(focusOnly ? focus?.itemId : undefined);
        if (alive) { setHistory(recent); setHistoryError(""); }
      } catch (e) { if (alive) setHistoryError(describeError(e)); }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [page, focus, focusOnly]);

  const pendingIds = submitted.filter((p) => !PLAN_TERMINAL_STATES.includes(p.state)).map((p) => p.id).join(",");
  useEffect(() => {
    if (!pendingIds) return;
    const ids = pendingIds.split(",").map(Number);
    let alive = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      const rows = await Promise.allSettled(ids.map(getImportPlan));
      pending = false;
      if (!alive) return;
      const next = rows.flatMap((row) => row.status === "fulfilled" ? [row.value] : []);
      setSubmitted((before) => before.map((plan) => {
        const current = next.find((p) => p.id === plan.id);
        return current ? { ...current, jobId: current.jobId ?? plan.jobId } : plan;
      }));
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [pendingIds]);

  function changePick(unit: WorkbenchItem) {
    if (busy || !unit.importable) return;
    preferenceApplied.current = true;
    if (picked.some((p) => p.unitId === unit.unitId)) {
      setPicked(picked.filter((p) => p.unitId !== unit.unitId));
      setConflict(null);
      return;
    }
    const previous = picked.filter((p) => sameSlot(p, unit));
    if (previous.length) {
      setConflict({ next: unit, previous });
    } else {
      setPicked([...picked, unit]);
      setConflict(null);
    }
  }

  async function inspect() {
    if (!canInspect) return;
    setBusy(true); setActionError(""); setRiskAck(false); setPartialAck(false); setBatch(null);
    try {
      const result = await createImportPlans({
        unitIds: picked.map((u) => u.unitId), projectPath: projectPath.trim(), includeSuggested: false,
      });
      const selected = new Map(picked.map((u) => [u.unitId, u.itemId]));
      if (result.plans.some((plan) => !plan.projectPath || normalizePath(plan.projectPath) !== normalizePath(projectPath.trim())
        || plan.units.some((unit) => selected.get(unit.unitId) !== plan.itemId))) {
        throw new Error("检查返回的包或工程与导入清单不符，请重新检查。");
      }
      const covered = new Set(result.plans.flatMap((p) => p.units.map((u) => u.unitId)));
      const rejected = new Set(result.errors.map((e) => e.itemId));
      for (const itemId of new Set(picked.filter((u) => !covered.has(u.unitId)).map((u) => u.itemId))) {
        if (!rejected.has(itemId)) result.errors.push({ itemId, message: "服务端未返回该素材的完整检查结果" });
      }
      setBatch(result); setPage("review");
    } catch (e) { setActionError(describeError(e)); }
    finally { setBusy(false); }
  }

  const invalidItems = new Set(batch?.errors.map((e) => e.itemId));
  const readyPlans = batch?.plans.filter((p) => !isBlocked(p) && !invalidItems.has(p.itemId)) ?? [];
  const blockedCount = (batch?.plans.length ?? 0) - readyPlans.length + (batch?.errors.filter((e) => !batch.plans.some((p) => p.itemId === e.itemId)).length ?? 0);
  const pickedItemIds = new Set(picked.map((unit) => unit.itemId));
  const omitted = loadoutPackages.filter((row) => !pickedItemIds.has(row.id));
  const skippedCount = loadout ? loadout.items.length - new Set(readyPlans.map((plan) => plan.itemId)).size : blockedCount;
  const wantsRiskAck = readyPlans.some(needsAck);
  const countToImport = readyPlans.reduce((n, plan) => n + plan.units.length, 0);
  const canSubmit = !busy && !probing && matchesEditor && countToImport > 0 && (!skippedCount || partialAck) && (!wantsRiskAck || riskAck);

  async function importChecked() {
    if (!canSubmit) return;
    setBusy(true); setActionError(""); setSubmitted([]); setSubmitErrors([]);
    try {
      const current = await probeUnity();
      const currentPath = current?.ok ? current.editor?.projectPath : undefined;
      if (!currentPath || normalizePath(currentPath) !== normalizePath(projectPath.trim())) {
        setActionError("Unity 当前打开的工程与本次检查的目标不一致。打开目标工程后重新检测，或返回更改工程。");
        return;
      }
      setPage("result");
      for (const plan of readyPlans) {
        try {
          await confirmImportPlan(plan.id, riskAck);
          const ack = await executeImportPlan(plan.id);
          if (ack.jobId === null && ack.runId === null) throw new Error("导入接口未返回作业状态，请查看导入记录");
          setSubmitted((before) => [...before, { ...plan, jobId: ack.jobId, runId: ack.runId }]);
        } catch (e) {
          setSubmitErrors((before) => [...before, titleOf(plan.itemId) + "：" + describeError(e)]);
        }
      }
    } finally { setBusy(false); }
  }

  function backToSelection() {
    if (submitted.length) {
      const sent = new Set(submitted.flatMap((plan) => plan.units.map((unit) => unit.unitId)));
      setPicked((before) => before.filter((unit) => !sent.has(unit.unitId)));
      setSubmitted([]);
    }
    setPage("pick"); setBatch(null); setActionError(""); setPartialAck(false); setRiskAck(false);
  }

  const groups = useMemo(() => {
    const byItem = new Map<number, WorkbenchItem[]>();
    for (const unit of units) {
      const group = byItem.get(unit.itemId);
      if (group) group.push(unit);
      else byItem.set(unit.itemId, [unit]);
    }
    return [...byItem.values()];
  }, [units]);

  const titleOf = (itemId: number | null) => picked.find((u) => u.itemId === itemId)?.title
    ?? loadout?.items.find((item) => item.id === itemId)?.title
    ?? (itemId === focus?.itemId ? focus?.title : null) ?? (itemId ? "素材 #" + itemId : "部分素材");
  const savedProjects = (props.projects ?? []).filter((p) => p.path && normalizePath(p.path) !== normalizePath(editorPath ?? ""));
  const namedProject = (props.projects ?? []).find((p) => normalizePath(p.path) === normalizePath(projectPath));
  const projectLabel = targetProject?.name ?? (matchesEditor ? editor?.editor?.projectName : namedProject?.name);
  const selectedIds = new Set(picked.map((p) => p.unitId));
  const filteredLoadoutPackages = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return loadoutPackages;
    return loadoutPackages.flatMap((row) => {
      if (row.title.toLowerCase().includes(needle)) return [row];
      const units = row.units.filter((unit) => [unit.packageName, unit.relPath, unit.containerPath]
        .some((value) => value?.toLowerCase().includes(needle)));
      return units.length ? [{ ...row, units }] : [];
    });
  }, [loadoutPackages, q]);
  const browserRows = loadout ? filteredLoadoutPackages : groups.map((units) => ({
    id: units[0]!.itemId, title: units[0]!.title, units,
  }));
  const canInspect = !busy && picked.length > 0 && !!projectPath.trim() && !conflict
    && (!loadout || (!loading && !analysisBusy && !analysis));

  return (
    <div className="backdrop" onClick={() => { if (!busy) props.onClose(); }}>
      <div className="drawer wb-drawer" role="dialog" aria-label="素材工作台" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>{loadout ? "导入搭配 · " + loadout.name
            : focusOnly && focus ? "导入到 Unity · " + (focus.title || "素材 #" + focus.itemId) : "素材工作台"}</h3>
          <button className="btn tiny" disabled={busy} onClick={() => page === "history" ? backToSelection() : setPage("history")}>
            {page === "history" ? "返回选包" : "导入记录"}
          </button>
          <button className="btn" disabled={busy} onClick={props.onClose}>{loadout ? "返回搭配" : "关闭"}</button>
        </div>

        {page !== "history" && <div className="wb-project">
          <div className="row wrap">
            <b>目标工程</b>
            <Badge tone={matchesEditor ? "ok" : "warn"}>
              {probing ? "正在检测 Unity" : matchesEditor ? "已连接" : editorPath ? "当前打开的是另一个工程" : "Unity 未连接"}
            </Badge>
            <span className="spacer" />
            <button className="btn tiny" disabled={probing || busy} onClick={() => void probeUnity()}>重新检测</button>
          </div>
          {page === "pick" && !targetProject ? (
            <>
              <select aria-label="选择 Unity 工程" value={editorPath && matchesEditor ? editorPath : savedProjects.some((p) => p.path === projectPath) ? projectPath : projectPath ? "_custom" : ""}
                disabled={busy} onChange={(e) => setProjectPath(e.target.value === "_custom" ? "" : e.target.value)}>
                <option value="">选择或打开 Unity 工程</option>
                {editorPath && <option value={editorPath}>当前打开 · {editor?.editor?.projectName || editorPath}</option>}
                {savedProjects.map((p) => <option key={p.id} value={p.path}>{p.name}</option>)}
                {projectPath && !matchesEditor && !savedProjects.some((p) => p.path === projectPath) && <option value="_custom">手动输入的工程</option>}
              </select>
              <details><summary>手动输入工程路径</summary>
                <input type="text" aria-label="Unity 工程路径" value={projectPath} disabled={busy} onChange={(e) => setProjectPath(e.target.value)} />
              </details>
              {projectPath && <div className="hint wb-path">{projectPath}</div>}
            </>
          ) : <div className="wb-path">{projectLabel && <b>{projectLabel} · </b>}{projectPath}</div>}
          {page === "pick" && targetProject && <div className="hint">可在搭配清单切换目标工程。</div>}
          {page !== "result" && !matchesEditor && !probing && (
            <div className="hint">打开目标 Unity 工程并连接 MCP for Unity，连接后才能执行导入。</div>
          )}
          {!!editor?.dropped && <div className="notice">已忽略 {editor.dropped} 个非法或未授权的 Unity MCP 地址。</div>}
        </div>}

        {page === "pick" && <>
          <div className="wb-main">
            <div className="wb-browser">
              <div className="row wrap">
                <b>{loadout ? `本次搭配 · ${loadout.items.length} 项素材` : focusOnly ? "选择本条的包" : "选择素材"}</b>
                <span className="spacer" />
                {focus && <button className="btn tiny" disabled={busy} onClick={() => {
                  setFocusOnly(!focusOnly); setQuery(""); setOffset(0);
                }}>{focusOnly ? "浏览全部素材" : "返回本条素材"}</button>}
                {loadout && <button className="btn tiny" disabled={busy || loading || analysisBusy || !!analysis}
                  onClick={() => setRevision((n) => n + 1)}>刷新候选包</button>}
              </div>
              <div className="row wrap wb-filter">
                <input type="search" aria-label="搜索素材或包名" placeholder="搜索素材或包名" value={query} disabled={busy}
                  onChange={(e) => { setQuery(e.target.value); setOffset(0); }} />
                {!focusOnly && !loadout && <select aria-label="按 Avatar 筛选" value={avatarId ?? ""} disabled={busy}
                  onChange={(e) => { setAvatarId(e.target.value ? Number(e.target.value) : null); setOffset(0); }}>
                  <option value="">全部 Avatar · 含通用素材</option>
                  {avatars.map((avatar) => <option key={avatar.id} value={avatar.id}>{avatar.name}</option>)}
                </select>}
              </div>
              {focusOnly && focus && (
                <div className="row wrap">
                  {(!units.some((u) => u.importable) && !q) ? (
                    <button className="btn" onClick={() => void launchAnalysis(focus.itemId)} disabled={busy || loading || analysisBusy || !!analysis}>分析本条</button>
                  ) : (
                    <details>
                      <summary>结构分析</summary>
                      <button className="btn tiny" onClick={() => void launchAnalysis(focus.itemId)} disabled={busy || analysisBusy || !!analysis}>重新分析本条</button>
                    </details>
                  )}
                  <span className="hint" role="status">{analysisStatus}</span>
                </div>
              )}
              {!focusOnly && !loadout && <details>
                <summary>批量结构分析</summary>
                <div className="row wrap">
                  <button className="btn tiny" onClick={() => void launchAnalysis()} disabled={busy || analysisBusy || !!analysis}>补齐全库结构</button>
                  <span className="hint" role="status">{analysisStatus || "仅分析尚无结构结果的素材。"}</span>
                </div>
              </details>}
              {loadout && analysisStatus && <div className="hint" role="status">{analysisStatus}</div>}
              {listError && <div className="err">{listError} <button className="btn tiny" onClick={() => setRevision((n) => n + 1)}>重试</button></div>}
              {loading && <div className="hint"><Spinner /> 加载素材…</div>}
              {!loading && !listError && !browserRows.length && <div className="hint">
                {q ? "没有符合搜索条件的包。" : focusOnly ? "分析这条素材后，可在这里选择包。" : "这里显示已分析的包。也可以从素材详情进入，只分析那条素材。"}
              </div>}
              {!loading && browserRows.map((row: LoadoutPackages) => {
                const group = row.units;
                const first = group[0];
                const candidates = group.filter((unit) => unit.importable).length;
                return <details className="wb-group" key={row.id} open={focusOnly || !!loadout || undefined}>
                  <summary>
                    {first?.coverImageId && <img src={mediaUrl(first.coverImageId, 96)} alt="" loading="lazy" />}
                    <b>{row.title}</b>
                    {row.notice ? <Badge tone="warn">{row.notice}</Badge> : <span className="hint">
                      {group.some((u) => selectedIds.has(u.unitId)) && `${group.filter((u) => selectedIds.has(u.unitId)).length} 已选 · `}
                      {loadout && candidates > 1 ? `${candidates} 个候选包` : `${group.length} 包`}
                    </span>}
                  </summary>
                  {row.canAnalyze && <div className="wb-unit">
                    <button className="btn" disabled={busy || analysisBusy || !!analysis} onClick={() => void launchAnalysis(row.id)}>分析本条</button>
                  </div>}
                  {group.map((unit) => (
                    <div className="wb-unit" key={unit.unitId}>
                      <label className="wb-unit-label">
                        <input type="checkbox" checked={selectedIds.has(unit.unitId)} disabled={busy || !unit.importable} onChange={() => changePick(unit)} />
                        <span>
                          <b>{packageTitle(unit)}</b>
                          {unit.relPath && unit.relPath !== packageTitle(unit) && <span className="hint wb-path">{unit.relPath}</span>}
                        </span>
                        {!unit.importable ? <Badge tone="warn">{unit.assetStatus === "missing" ? "文件缺失" : "无法导入"}</Badge>
                          : unit.mixed ? <Badge tone="warn">混合整包</Badge>
                          : <Badge tone={LEVEL_TONE[unit.level]}>{LEVEL_LABEL[unit.level] ?? "待核对"}</Badge>}
                      </label>
                      {(unit.avatarMatches?.length || unit.evidence || unit.error) ? <details className="wb-unit-evidence">
                        <summary>适配与来源</summary>
                        {unit.avatarMatches?.map((avatar) => <div className="hint" key={avatar.id}>{avatar.name} · {LEVEL_LABEL[avatar.level] ?? avatar.level}</div>)}
                        {unit.evidence?.summary && <div className="hint wb-path">{unit.evidence.summary}</div>}
                        {unit.containerPath && <div className="hint wb-path">{shortenPath(unit.containerPath)}</div>}
                        {unit.error && <div className="err-text">{unit.error.message}</div>}
                      </details> : null}
                    </div>
                  ))}
                </details>;
              })}
              {!focusOnly && (offset > 0 || hasMore) && <div className="row">
                <button className="btn tiny" disabled={busy || loading || !offset} onClick={() => setOffset(offset - PAGE_SIZE)}>上一页</button>
                <button className="btn tiny" disabled={busy || loading || !hasMore} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页</button>
              </div>}
            </div>

            <div className="section wb-selection">
              <div className="row">
                <b>导入清单 · {picked.length} 个包</b><span className="spacer" />
                {picked.length > 0 && <button className="btn tiny" disabled={busy || (!!loadout && loading)} onClick={() => {
                  setPicked([]); setConflict(null); preferenceApplied.current = true;
                }}>清空</button>}
              </div>
              {picked.length === 0 && <div className="hint">展开素材，勾选要导入的包。</div>}
              {picked.map((unit) => <div className="row wb-package-note" key={unit.unitId}>
                <span><b>{packageTitle(unit)}</b><span className="hint">{unit.title}</span></span>
                <button className="btn tiny" disabled={busy} onClick={() => changePick(unit)}>移除</button>
              </div>)}
              {conflict && <div className="notice">
                <b>{packageTitle(conflict.next)} 与已选包冲突</b>
                {conflict.previous.map((p) => <div key={p.unitId}>{packageTitle(p)}</div>)}
                <div className="row wrap">
                  <button className="btn tiny" onClick={() => setConflict(null)}>保留原选择</button>
                  <button className="btn tiny" onClick={() => {
                    const displaced = new Set(conflict.previous.map((u) => u.unitId));
                    setPicked([...picked.filter((u) => !displaced.has(u.unitId)), conflict.next]); setConflict(null);
                  }}>替换为新选择</button>
                </div>
              </div>}
            </div>
          </div>
          <div className="wb-footer">
            {actionError && <div className="err" role="alert">{actionError}</div>}
            <button className="btn primary" disabled={!canInspect} onClick={() => void inspect()}>
              {busy ? "正在检查…" : "检查导入"}
            </button>
          </div>
        </>}

        {page === "review" && batch && <>
          <div className="wb-scroll">
            <h4>核对本次导入</h4>
            {omitted.length > 0 && <div className="notice">
              <b>本次未选包的素材</b>
              {omitted.map((row) => <div key={row.id}>{row.title} · {row.notice ?? "未选择导入包"}</div>)}
            </div>}
            {batch.errors.map((error, i) => <div className="err" key={i}>{titleOf(error.itemId)}：{error.message}</div>)}
            {batch.plans.map((plan) => (
              <section className="section" key={plan.id}>
                <b>{titleOf(plan.itemId)}</b>
                <RiskDetails plan={plan} />
              </section>
            ))}
          </div>
          <div className="wb-footer">
            {actionError && <div className="err" role="alert">{actionError}</div>}
            {skippedCount > 0 && countToImport > 0 && <label className="chk">
              <input type="checkbox" checked={partialAck} disabled={busy} onChange={(e) => setPartialAck(e.target.checked)} />
              {loadout ? `确认跳过 ${skippedCount} 项素材，只导入通过检查的已选包` : "跳过受阻的素材，只导入下方数量所示的包"}
            </label>}
            {wantsRiskAck && <label className="chk">
              <input type="checkbox" checked={riskAck} disabled={busy} onChange={(e) => setRiskAck(e.target.checked)} />
              我已核对风险提示，允许导入勾选的包（混合包会整包导入）
            </label>}
            <div className="row wrap">
              <button className="btn" disabled={busy} onClick={backToSelection}>返回调整包或工程</button>
              <button className="btn primary" disabled={!canSubmit} onClick={() => void importChecked()}>
                {busy ? "正在提交…" : countToImport ? "确认导入 " + countToImport + " 个包" : "没有可导入的包"}
              </button>
            </div>
          </div>
        </>}

        {(page === "result" || page === "history") && <div className="wb-scroll">
          <h4>{page === "result" ? "本次导入结果" : focusOnly ? "本条的最近导入记录" : "最近导入记录"}</h4>
          {page === "result" && skippedCount > 0 && <div className="notice">本次跳过 {skippedCount} 项素材。</div>}
          {page === "result" && busy && <div className="hint"><Spinner /> 正在提交导入作业…</div>}
          {page === "result" && submitErrors.map((error, i) => <div className="err" key={i}>{error}</div>)}
          {page === "history" && historyError && <div className="err">{historyError}</div>}
          {page === "history" && !history.length && !historyError && <div className="hint">暂无导入记录。</div>}
          {(page === "result" ? submitted : history).map((plan) => <ImportResult key={plan.id} plan={plan} />)}
          {page === "result" && <button className="btn" disabled={busy} onClick={backToSelection}>返回选包</button>}
        </div>}
      </div>
    </div>
  );
}
