import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  confirmImportPlan, createImportPlans, describeError, executeImportPlan, getImportPlan, getImportRun,
  listJobs, mediaUrl, scanAllWorkbench, unityStatus, workbenchAvatars, workbenchItems,
} from "../api";
import type { ImportPlan, PlanLatestRun, ImportRun, WorkbenchAvatar, WorkbenchItem } from "../types";
import { focusApplyAllowed, focusNotice, mapFocusToUnits, sameSlot, type FocusMap, type WorkbenchFocus } from "../workbench-focus";
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
 * - 清单**互斥**：同一压缩包（containerPath）里的多个单元只能选一个（导入其中一个就等于导入整包），
 *   同一 item + 同一包名也不重复。纯函数 `togglePick` 可单测。
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

function ItemRow(props: { item: WorkbenchItem; picked: boolean; onToggle: () => void }) {
  const it = props.item;
  const ev = it.evidence;
  return (
    <div
      className={"preview-row" + (props.picked ? " on" : "")}
      style={{ cursor: "pointer" }}
      onClick={props.onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); props.onToggle(); } }}
    >
      <div className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
        {it.coverImageId !== null
          ? <img src={mediaUrl(it.coverImageId, 96)} alt="" style={{ width: "54px", height: "54px", objectFit: "cover", borderRadius: "6px", border: "1px solid var(--line)", flex: "0 0 auto" }} />
          : <div className="hint" style={{ width: "54px", height: "54px", border: "1px dashed var(--line)", borderRadius: "6px", flex: "0 0 auto", display: "grid", placeItems: "center", fontSize: "10px" }}>无图</div>}
        <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: "2px" }}>
          <div className="row" style={{ gap: "5px", minWidth: 0 }}>
            <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</b>
            <Badge tone={LEVEL_TONE[it.level]} title={"证据级别：" + it.level}>{LEVEL_LABEL[it.level] ?? it.level}</Badge>
            {it.suggested && <Badge tone="violet" title="后端建议项：默认不加入计划，需你勾选">建议</Badge>}
            {it.mixed && <Badge tone="bad" title={MIXED_WARNING}>整包风险</Badge>}
            {!it.importable && <Badge tone="muted" title={"policy=" + it.policy + "，不可导入"}>不可导入</Badge>}
            <span className="spacer" />
            <span className="hint">{POLICY_LABEL[it.policy] ?? it.policy}</span>
          </div>
          <div className="hint mono" style={{ wordBreak: "break-all" }}>
            {it.packageName ? shortenPath(it.packageName, 60) : "—"}
            {it.relPath ? " › " + shortenPath(it.relPath, 52) : ""}
          </div>
          <div className="hint">
            {it.sourceSite ? it.sourceSite.toUpperCase() : "本地"}
            {it.sourceItemId ? " " + it.sourceItemId : ""}
            {it.shopName ? " · " + it.shopName : ""}
            {it.avatarName ? " · 目标 @" + it.avatarName : ""}
            {it.kind ? " · " + it.kind : ""}
          </div>
          {ev && (
            <div className="hint">
              <b>{LEVEL_LABEL[ev.level] ?? ev.level}</b>
              {ev.summary ? "：" + ev.summary : ""}
              {ev.sources.length ? "（" + ev.sources.join(" / ") + "）" : ""}
            </div>
          )}
          {it.error && <div className="err-text">{it.error.code}：{it.error.message}</div>}
        </div>
        <span className="hint" style={{ flex: "0 0 auto", opacity: it.importable ? 1 : 0.45 }}>
          {!it.importable ? "不可加入" : props.picked ? "✓ 已加入" : "加入 →"}
        </span>
      </div>
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

export function AvatarWorkbench(props: {
  onClose: () => void;
  onToast: (kind: "ok" | "bad" | "info", text: string) => void;
  /** 从条目详情「带入清单」打开的上下文：定位条目 + 按 assetId/relPath 精确映射已勾选的包。 */
  focus?: WorkbenchFocus | null;
}) {
  const focus = props.focus ?? null;
  const [avatars, setAvatars] = useState<WorkbenchAvatar[]>([]);
  const [avatarId, setAvatarId] = useState<number | null>(null);
  const [avatarsLoading, setAvatarsLoading] = useState(true);
  const [avatarsErr, setAvatarsErr] = useState("");

  const [q, setQ] = useState("");
  const debouncedQ = useDebounced(q, 250);
  /** 后端支持的条目状态过滤（inbox/active/archived/trashed）；分类不在 /workbench/units 契约里。 */
  const [itemStatus, setItemStatus] = useState("");
  const [level, setLevel] = useState("");
  const [policy, setPolicy] = useState("");
  const [confirmedOnly, setConfirmedOnly] = useState(false);

  const [items, setItems] = useState<WorkbenchItem[]>([]);
  const [itemsTotal, setItemsTotal] = useState(0);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsErr, setItemsErr] = useState("");
  /** 从详情页打开时只看该条目的单元（可切回当前 Avatar 的单元）。 */
  const [focusOnly, setFocusOnly] = useState(!!focus);
  /** 当前 items 对应哪个查询范围（focus:123 / avatar:5），用来判断"该范围已加载完"。 */
  const [itemsLoadedFor, setItemsLoadedFor] = useState("");
  /** 详情页上下文 → 单元的映射结论（预选多少、哪些没对上）。 */
  const [focusMap, setFocusMap] = useState<FocusMap | null>(null);
  /** 同一个 focus 只带入一次：用户之后自己勾选/取消不被覆盖。 */
  const focusAppliedRef = useRef("");

  const [picked, setPicked] = useState<WorkbenchItem[]>([]);
  const [projectPath, setProjectPath] = useState("");
  const [projectName, setProjectName] = useState("");
  const [probing, setProbing] = useState(false);
  /** Unity 工程里认出的 Avatar（/workbench/avatars 为空时兜底）。 */
  const [projectAvatar, setProjectAvatar] = useState<{ id: number; name: string } | null>(null);
  const [avatarFallback, setAvatarFallback] = useState(false);
  /** scan-all 的 job id（轮询到终态后刷新 avatars/units）。 */
  const [scanJob, setScanJob] = useState<number | null>(null);
  const [scanAllBusy, setScanAllBusy] = useState(false);
  const projectAvatarRef = useRef<{ id: number; name: string } | null>(null);
  const avatarsRef = useRef<WorkbenchAvatar[]>([]);
  avatarsRef.current = avatars;
  /** 打开面板只自动探测一次：之后只有手点「探测」才会再发请求。 */
  const probedRef = useRef(false);
  const toastRef = useRef(props.onToast);
  toastRef.current = props.onToast;

  /** 后端按 item 建计划，所以这里可能是多个（通常 1 个）。 */
  const [plans, setPlans] = useState<ImportPlan[]>([]);
  /** 勾选状态键 = `${planId}:${unitId}`；suggested / state==="suggested" 默认不勾选。 */
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [planBusy, setPlanBusy] = useState(false);
  const [planErr, setPlanErr] = useState("");

  const [runs, setRuns] = useState<ImportRun[]>([]);
  const [runErr, setRunErr] = useState("");
  /** 已提交执行、需要继续轮询的计划 id（execute 只回 202 {jobId,planId}）。 */
  const [pollPlanIds, setPollPlanIds] = useState<number[]>([]);
  /** planId → 执行作业 id（仅用于展示 "job #N"）。 */
  const [ackedJobs, setAckedJobs] = useState<Record<number, number>>({});
  /** planId → 风险提示是否已显式确认（warning / unknown 必须勾；blocked 勾了也不放行）。 */
  const [riskAcks, setRiskAcks] = useState<Record<number, boolean>>({});

  // ① Avatar 列表
  const applyAvatarList = useCallback((list: WorkbenchAvatar[]) => {
    if (list.length) {
      setAvatars(list); setAvatarFallback(false);
      setAvatarId((cur) => (cur === null || !list.some((a) => a.id === cur) ? list[0].id : cur));
      return;
    }
    // 列表为空：用 Unity 工程里认出的头像兜底并选中，别让用户面对一片空白
    const pa = projectAvatarRef.current;
    if (pa) { setAvatars([fallbackAvatarOf(pa)]); setAvatarFallback(true); setAvatarId(pa.id); return; }
    setAvatars([]); setAvatarFallback(false); setAvatarId(null);
  }, []);

  const loadAvatars = useCallback(() => {
    setAvatarsLoading(true); setAvatarsErr("");
    workbenchAvatars()
      .then((list) => applyAvatarList(list))
      .catch((e) => setAvatarsErr(describeError(e)))
      .finally(() => setAvatarsLoading(false));
  }, [applyAvatarList]);

  useEffect(() => { loadAvatars(); }, [loadAvatars]);

  // ② Unity 工程：**打开面板只自动探测一次**（probedRef 守卫），之后只有手点「探测」才会再发请求；
  //    成功一律静默（不 toast），失败也只在手动探测时提示。
  const probeUnity = useCallback((manual = false): void => {
    setProbing(true);
    unityStatus()
      .then((s) => {
        const p = s.editor?.projectPath ?? "";
        if (p) { setProjectPath(p); setProjectName(s.editor?.projectName ?? ""); }
        const pa = s.projectAvatar ?? null;
        if (pa) {
          projectAvatarRef.current = { id: pa.id, name: pa.name };
          setProjectAvatar(projectAvatarRef.current);
          // avatars 为空 → 用它兜底并选中（否则左侧一片空白，用户以为探测失败）
          if (avatarsRef.current.length === 0) {
            setAvatars([fallbackAvatarOf(pa)]);
            setAvatarFallback(true);
            setAvatarId(pa.id);
          }
        }
        if (!p && manual) toastRef.current("info", "没探测到打开的 Unity 工程（可手填路径，或先打开工程再点探测）");
      })
      .catch(() => { if (manual) toastRef.current("info", "Unity 探测失败：编辑器没开或 MCP 不可达"); })
      .finally(() => setProbing(false));
  }, []);

  useEffect(() => {
    if (probedRef.current) return;
    probedRef.current = true;
    probeUnity(false);
  }, [probeUnity]);

  // ③ 素材单元（有详情页上下文时默认只看该条目；?itemId= 走后端过滤）
  const loadItems = useCallback(() => {
    const focused = focusOnly && focus !== null;
    const scopeKey = focused ? "focus:" + focus.itemId : "avatar:" + String(avatarId ?? "none");
    if (!focused && avatarId === null) { setItems([]); setItemsTotal(0); setItemsLoadedFor(scopeKey); return; }
    setItemsLoading(true); setItemsErr("");
    workbenchItems({
      avatarId: focused ? undefined : avatarId ?? undefined,
      itemId: focused ? focus.itemId : undefined,
      level: (confirmedOnly ? "confirmed" : level) || undefined,
      policy: policy || undefined,
      itemStatus: itemStatus || undefined,
      limit: 500,
    })
      .then((r) => {
        // 关键词后端不支持：本地按 标题/包名/relPath/@Avatar 过滤
        const needle = debouncedQ.trim().toLowerCase();
        const list = needle
          ? r.items.filter((it) => [it.title, it.packageName ?? "", it.relPath ?? "", it.avatarName ?? ""]
              .join(" ").toLowerCase().includes(needle))
          : r.items;
        setItems(list); setItemsTotal(list.length);
      })
      .catch((e) => { setItems([]); setItemsTotal(0); setItemsErr(describeError(e)); })
      .finally(() => { setItemsLoading(false); setItemsLoadedFor(scopeKey); });
  }, [avatarId, debouncedQ, itemStatus, level, policy, confirmedOnly, focusOnly, focus]);

  useEffect(() => { loadItems(); }, [loadItems]);

  // 详情页带入的包 → 工作台单元：**精确映射才预选**；不明确时只给提示，不替用户做取舍。
  useEffect(() => {
    if (!focus) return;
    const key = "focus:" + focus.itemId;
    if (itemsLoadedFor !== key || focusAppliedRef.current === key) return;
    const map = mapFocusToUnits(focus, items);
    setFocusMap(map);
    // 该条目还没有单元（未做结构分析）：先不置位，扫描完成加载 units 后可再精确预选一次。
    if (!focusApplyAllowed(focus, items, focusAppliedRef.current)) return;
    if (map.preselected.length) {
      const byId = new Map(items.map((u) => [u.unitId, u]));
      setPicked(map.preselected.map((id) => byId.get(id)).filter((u): u is WorkbenchItem => !!u));
    }
    focusAppliedRef.current = key;
  }, [focus, items, itemsLoadedFor]);

  // ④ 一键补结构分析：提交 scan-all（onlyMissing）→ 轮询 /api/jobs 里那条 → 完成后刷新 avatars/units
  const scanAll = useCallback((): void => {
    if (scanAllBusy) return;
    setScanAllBusy(true);
    scanAllWorkbench(true)
      .then((r) => {
        if (!r.jobId) {
          setScanAllBusy(false);
          toastRef.current("bad", "后端没有返回 jobId（/api/workbench/scan-all）");
          return;
        }
        setScanJob(r.jobId);
        toastRef.current("ok", "已提交结构扫描（job #" + r.jobId + "），完成后自动刷新");
      })
      .catch((e) => {
        setScanAllBusy(false);
        toastRef.current("bad", "提交扫描失败：" + describeError(e));
      });
  }, [scanAllBusy]);

  useEffect(() => {
    if (scanJob === null) return;
    const tick = (): void => {
      if (typeof document !== "undefined" && document.hidden) return;
      listJobs(undefined, 50)
        .then((r) => {
          const j = r.jobs.find((x) => x.id === scanJob);
          if (!j) return;
          if (!["done", "failed", "cancelled", "abandoned"].includes(j.state)) return;
          setScanJob(null);
          setScanAllBusy(false);
          toastRef.current(
            j.state === "done" ? "ok" : "bad",
            "结构扫描 " + j.state + (j.error ? "：" + j.error : "") + "，已刷新列表",
          );
          loadAvatars();
          loadItems();
        })
        .catch(() => { /* 下一轮再试 */ });
    };
    const timer = setInterval(tick, 2000);
    return () => clearInterval(timer);
  }, [scanJob, loadAvatars, loadItems]);

  // ⑤ 计划/执行轮询（只在还有在飞单元时跑；页面隐藏时跳过）
  const refreshRun = useCallback((id: number) => {
    getImportRun(id)
      .then((r) => {
        setRuns((list) => (list.some((x) => x.id === r.id) ? list.map((x) => (x.id === r.id ? r : x)) : [...list, r]));
        setRunErr("");
      })
      .catch((e) => setRunErr(describeError(e)));
  }, []);

  const busyRun = useMemo(() => runs.some((r) => isRunBusy(r)), [runs]);
  useEffect(() => {
    const activeRuns = runs.filter((r) => isRunBusy(r)).map((r) => r.id);
    if (!pollPlanIds.length && !activeRuns.length) return;
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      for (const rid of activeRuns) refreshRun(rid);
      // 计划：拿最新状态；一旦暴露出 run_id 就去拉 run；到终态就停止轮询它
      for (const pid of pollPlanIds) {
        getImportPlan(pid)
          .then((np) => {
            setPlans((list) => list.map((x) => (x.id === np.id ? np : x)));
            if (np.runId !== null) refreshRun(np.runId);
            if (PLAN_TERMINAL_STATES.includes(np.state)) setPollPlanIds((ids) => ids.filter((x) => x !== np.id));
          })
          .catch(() => { /* 下一轮再试；不因一次抖动停止轮询 */ });
      }
    };
    const timer = setInterval(tick, 1500);
    return () => clearInterval(timer);
  }, [pollPlanIds, runs, refreshRun]);

  const makePlan = () => {
    if (!picked.length) { props.onToast("bad", "导入清单还是空的"); return; }
    const path = projectPath.trim();
    if (!path) { props.onToast("bad", "先填 Unity 工程路径"); return; }
    setPlanBusy(true); setPlanErr(""); setRuns([]); setRunErr(""); setPollPlanIds([]); setAckedJobs({}); setRiskAcks({});
    // 后端 createImportPlan 只认 unitIds / projectPath / includeSuggested，且一次只能属于同一 item
    createImportPlans({
      projectPath: path,
      unitIds: picked.map((u) => u.unitId),
      includeSuggested: false,
    })
      .then((list) => {
        setPlans(list);
        // suggested（或计划项状态就是 suggested）一律不勾选；其余默认勾选
        const next: Record<string, boolean> = {};
        for (const p of list) for (const u of p.units) next[p.id + ":" + u.unitId] = !(u.suggested || u.state === "suggested");
        setChecks(next);
        const warned = list.filter((p) => !p.precheck.ok).length;
        props.onToast("ok", plansToastText(list.length, warned));
      })
      .catch((e) => { setPlans([]); setPlanErr(describeError(e)); props.onToast("bad", "生成计划失败：" + describeError(e)); })
      .finally(() => setPlanBusy(false));
  };

  const doConfirm = async (): Promise<void> => {
    if (!plans.length) return;
    const targets = plans
      .map((p) => ({ plan: p, unitIds: p.units.filter((u) => checks[p.id + ":" + u.unitId]).map((u) => u.unitId) }))
      .filter((t) => t.unitIds.length > 0);
    if (!targets.length) { props.onToast("bad", "至少要勾选一个单元"); return; }
    setPlanBusy(true);
    const jobs: number[] = [];
    const failures: string[] = [];
    // 每个计划**独立** confirm → execute：一个失败不影响其它计划（跨条目建计划时会有多个 PlanView）
    for (const t of targets) {
      try {
        // ① confirm：只做人工确认（suggested → pending、user_confirmed=1），**不执行**
        const confirmed = await confirmImportPlan(t.plan.id);
        setPlans((list) => list.map((x) => (x.id === confirmed.plan.id ? confirmed.plan : x)));
        // ② execute：Job 化执行 → 202 {jobId, planId}（不返回 run，run 由 plan 暴露后再轮询）
        const ack = await executeImportPlan(t.plan.id);
        const planId = ack.planId || t.plan.id;
        if (ack.jobId !== null) {
          jobs.push(ack.jobId);
          setAckedJobs((m) => ({ ...m, [planId]: ack.jobId as number }));
        }
        setPollPlanIds((ids) => (ids.includes(planId) ? ids : [...ids, planId]));
        if (ack.runId !== null) refreshRun(ack.runId);
        // 立刻拉一次计划（可能已经带上 run_id），以后按 1.5s 轮询
        getImportPlan(planId)
          .then((np) => {
            setPlans((list) => list.map((x) => (x.id === np.id ? np : x)));
            if (np.runId !== null) refreshRun(np.runId);
          })
          .catch(() => { /* 轮询里会再试 */ });
      } catch (e) {
        failures.push("计划 #" + t.plan.id + "：" + describeError(e));
      }
    }
    setPlanBusy(false);
    if (failures.length) {
      props.onToast("bad", failures.length + " / " + targets.length + " 个计划提交失败：" + failures.slice(0, 2).join("；"));
    } else if (jobs.length) {
      props.onToast("ok", "已提交执行（job " + jobs.map((n) => "#" + n).join(", ") + "），正在轮询计划/执行状态");
    } else {
      props.onToast("ok", "已确认并提交 " + targets.length + " 个计划，正在轮询执行状态");
    }
  };

  /** failed 才允许重建：按该计划自己的单元重新建一个新计划（旧计划保留为 failed，便于取证）。 */
  const rebuildPlan = useCallback((p: ImportPlan): void => {
    if (!canRebuildPlan(p.state)) return;
    const path = (projectPath.trim() || p.projectPath || "").trim();
    if (!path) { props.onToast("bad", "先填 Unity 工程路径"); return; }
    setPlanBusy(true);
    createImportPlans({ projectPath: path, unitIds: p.units.map((u) => u.unitId), includeSuggested: false })
      .then((list) => {
        setPlans((prev) => [...list, ...prev]);
        setChecks((m) => {
          const next = { ...m };
          for (const np of list) for (const u of np.units) next[np.id + ":" + u.unitId] = !(u.suggested || u.state === "suggested");
          return next;
        });
        setRiskAcks((m) => { const next = { ...m }; for (const np of list) delete next[np.id]; return next; });
        props.onToast("ok", "已重建 " + list.length + " 个计划（旧计划保留为 failed）");
      })
      .catch((e) => props.onToast("bad", "重建计划失败：" + describeError(e)))
      .finally(() => setPlanBusy(false));
  }, [projectPath, props]);

  const toggleCheck = (planId: number, unitId: string) => setChecks((m) => {
    const k = planId + ":" + unitId;
    return { ...m, [k]: !m[k] };
  });
  const checksOf = (p: ImportPlan): Record<string, boolean> => {
    const out: Record<string, boolean> = {};
    for (const u of p.units) out[u.unitId] = !!checks[p.id + ":" + u.unitId];
    return out;
  };
  const currentAvatar = avatars.find((a) => a.id === avatarId) ?? null;

  return (
    <div className="backdrop" onClick={props.onClose}>
      <div className="drawer" role="dialog" aria-label="Avatar 素材工作台" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>Avatar 素材工作台</h3>
          <span className="hint">选 Avatar → 看证据/策略 → 进导入清单 → 生成计划 → 确认执行</span>
          <span className="spacer" />
          <button className="btn tiny" onClick={loadAvatars} title="重新拉取 Avatar 与计数">刷新</button>
          <button className="btn" onClick={props.onClose}>关闭</button>
        </div>

        <div className="drawer-body">
          {/* 左：Avatar + 筛选 + 素材卡片 */}
          <div className="left">
            {focus && (
              <div className="notice" data-workbench-focus="1">
                <div className="row" style={{ gap: "6px", alignItems: "flex-start" }}>
                  <b style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    来自条目「{focus.title?.trim() || "#" + focus.itemId}」
                  </b>
                  <span className="spacer" />
                  <button className="btn tiny" onClick={() => setFocusOnly((v) => !v)}>
                    {focusOnly ? "看全部 Avatar 的单元" : "只看这个条目"}
                  </button>
                </div>
                <div className="hint" style={{ marginTop: "4px" }}>
                  {focusMap ? focusNotice(focus, focusMap) : "正在按 assetId + relPath 把详情页勾选的包对应到单元…"}
                </div>
              </div>
            )}
            <div className="hint">① 选择 Avatar（括号内是工作台计数）</div>
            {avatarsErr && <div className="err">工作台接口不可用：{avatarsErr}</div>}
            {avatarsLoading && !avatars.length && <div className="hint"><Spinner /> 载入 Avatar…</div>}
            <div className="preview-list" style={{ maxHeight: "26vh" }}>
              {avatars.map((a) => (
                <button
                  key={a.id}
                  className={"preview-row" + (a.id === avatarId ? " on" : "")}
                  onClick={() => { setAvatarId(a.id); setFocusOnly(false); }}
                  title={focusOnly ? "选中这个 Avatar 并切回它的单元列表" : undefined}
                >
                  <span className="row" style={{ gap: "6px" }}>
                    <b>{a.name}</b>
                    <Badge tone={a.owned ? "ok" : "muted"}>{a.owned ? "已拥有" : "未拥有"}</Badge>
                    <span className="spacer" />
                    <span className="hint">{a.counts.total} 单元</span>
                  </span>
                  <span className="hint">
                    已确认 {a.counts.confirmed} · 可能 {a.counts.probable} · 未知 {a.counts.unknown} · 整包 {a.counts.mixed}
                  </span>
                </button>
              ))}
              {!avatarsLoading && !avatars.length && !avatarsErr && <div className="hint" style={{ padding: "8px" }}>没有可选的 Avatar</div>}
              {avatarFallback && (
                <div className="notice">
                  Avatar 列表为空：已用 Unity 工程里认出的 <b>@{projectAvatar?.name ?? avatars[0]?.name ?? "?"}</b> 兜底并选中；
                  点「扫描全部结构」补齐库里的证据计数。
                </div>
              )}
            </div>

            <div className="row wrap" style={{ gap: "5px" }}>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="关键词：名称 / 包名" style={{ flex: "1 1 120px" }} />
              <select value={itemStatus} onChange={(e) => setItemStatus(e.target.value)} title="条目状态（后端 itemStatus）" style={{ width: "110px" }}>
                <option value="">全部条目</option>
                <option value="inbox">待整理</option>
                <option value="active">在库</option>
                <option value="archived">归档</option>
              </select>
              <select value={level} onChange={(e) => setLevel(e.target.value)} title="证据级别" style={{ width: "104px" }}>
                <option value="">全部级别</option>
                <option value="confirmed">已确认</option>
                <option value="probable">可能</option>
                <option value="unknown">未知</option>
              </select>
              <select value={policy} onChange={(e) => setPolicy(e.target.value)} title="打包策略" style={{ width: "104px" }}>
                <option value="">全部策略</option>
                <option value="single_unitypackage">独立包</option>
                <option value="mixed_unitypackage">混合整包</option>
                <option value="unknown_structure">结构未知</option>
              </select>
              <label className="chk"><input type="checkbox" checked={confirmedOnly} onChange={(e) => setConfirmedOnly(e.target.checked)} />仅已确认</label>
            </div>

            <div className="row" style={{ gap: "6px" }}>
              <span className="hint">② 素材单元 {itemsTotal ? "（" + items.length + " / " + itemsTotal + "）" : ""}</span>
              <span className="spacer" />
              {itemsLoading && <Spinner />}
              <button
                className="btn tiny"
                onClick={scanAll}
                disabled={scanAllBusy || scanJob !== null}
                title="POST /api/workbench/scan-all {onlyMissing:true} —— 只给还没分析过的条目补结构分析"
              >
                {scanJob !== null ? "扫描中…" : SCAN_ALL_LABEL}
              </button>
              <button className="btn tiny" onClick={loadItems} disabled={avatarId === null && !(focusOnly && focus)}>刷新</button>
            </div>
            {itemsErr && <div className="err">素材接口不可用：{itemsErr}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: "5px", overflow: "auto", minHeight: 0 }}>
              {items.map((it) => (
                <ItemRow
                  key={it.unitId}
                  item={it}
                  picked={picked.some((p) => p.unitId === it.unitId)}
                  onToggle={() => setPicked((p) => togglePick(p, it))}
                />
              ))}
              {!itemsLoading && !items.length && !itemsErr && (
                focusOnly && focus
                  ? <div className="hint" style={{ padding: "10px" }}>
                      条目「{focus.title?.trim() || "#" + focus.itemId}」还没有已分析的素材单元；可点上面「扫描全部结构」补齐（只补没分析过的条目），或切回「看全部 Avatar 的单元」。
                    </div>
                  : avatarId === null
                  ? <div className="hint" style={{ padding: "10px" }}>先选一个 Avatar</div>
                  : <UnitsEmptyState
                      scanning={scanAllBusy || scanJob !== null}
                      onScanAll={scanAll}
                      avatarName={currentAvatar?.name ?? null}
                      fallbackFromUnity={avatarFallback}
                    />
              )}
            </div>
          </div>

          {/* 右：导入清单 / Unity 工程 / 计划 / 执行 */}
          <div className="right">
            <div className="section" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <div className="row" style={{ gap: "6px" }}>
                <b>导入清单（{picked.length}）</b>
                {currentAvatar && <span className="hint">→ @{currentAvatar.name}</span>}
                {anyMixed(picked) && <Badge tone="bad">含整包风险</Badge>}
                <span className="spacer" />
                {picked.length > 0 && <button className="btn tiny" onClick={() => setPicked([])}>清空</button>}
              </div>
              {picked.length === 0 && <div className="hint">从左边的素材卡片点「加入 →」；同一压缩包里的单元互斥，选一个会自动替换同包的另一个。</div>}
              {picked.map((u) => (
                <div className="row" key={u.unitId} style={{ gap: "6px", alignItems: "flex-start" }}>
                  <Badge tone={LEVEL_TONE[u.level]}>{LEVEL_LABEL[u.level] ?? u.level}</Badge>
                  <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={u.packageName ?? u.title}>{u.title}</span>
                  {u.mixed && <Badge tone="bad">整包</Badge>}
                  <button className="btn tiny ghost" onClick={() => setPicked((p) => togglePick(p, u))}>移除</button>
                </div>
              ))}
              {anyMixed(picked) && <div className="err">{MIXED_WARNING}</div>}
            </div>

            <div className="section" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <div className="row" style={{ gap: "6px" }}>
                <b>③ Unity 工程</b>
                {probing && <Spinner />}
                {projectName && <span className="hint">已探测：{projectName}</span>}
                <span className="spacer" />
                <button className="btn tiny" onClick={() => probeUnity(true)} disabled={probing}>{probing ? "探测中…" : "探测"}</button>
              </div>
              <input value={projectPath} onChange={(e) => setProjectPath(e.target.value)} placeholder="工程路径，如 E:/unity/MyAvatarProject" />
              <div className="row" style={{ gap: "6px" }}>
                <button className="btn primary" onClick={makePlan} disabled={planBusy || !picked.length || !projectPath.trim()}>
                  {planBusy ? <Spinner /> : null}生成导入计划
                </button>
                <span className="hint">只读预检，不动 Unity</span>
              </div>
              {planErr && <div className="err">{planErr}</div>}
            </div>

            <PlansSection
              plans={plans}
              checksFor={checksOf}
              onToggle={toggleCheck}
              onConfirm={() => void doConfirm()}
              busy={planBusy}
              ackedJobs={ackedJobs}
              riskAcks={riskAcks}
              onRiskAck={(id, v) => setRiskAcks((m) => ({ ...m, [id]: v }))}
              onRebuild={rebuildPlan}
            />

            {(runs.length > 0 || runErr) && (
              <div className="section" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <div className="row" style={{ gap: "6px" }}>
                  <b>⑤ 执行状态</b>
                  {busyRun && <Spinner />}
                  <span className="spacer" />
                </div>
                {runErr && <div className="err">{runErr}</div>}
                {runs.map((run) => <RunCard key={run.id} run={run} />)}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
