import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  confirmImportPlan, createImportPlans, describeError, executeImportPlan, getImportPlan, getImportRun,
  mediaUrl, unityStatus, workbenchAvatars, workbenchItems,
} from "../api";
import type { ImportPlan, ImportRun, WorkbenchAvatar, WorkbenchItem } from "../types";
import { formatDate, shortenPath } from "../util";
import { Badge, Spinner, useDebounced } from "./ui";

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
  // 计划项（import_plan_items.status）也用同一张表；不新增状态，只是给后端已有值配文案
  pending: "待导入",
  suggested: "建议（待确认）",
};
export const UNIT_STATE_TONE: Record<string, Tone> = {
  planned: "muted", importing: "busy", import_command_completed: "busy",
  verifying: "busy", verified: "ok", partial_success: "warn", failed: "bad", unknown: "muted",
};

/** 计划状态 → 中文（后端 import_plans.status：ready / running / executed / failed / blocked）。 */
export const PLAN_STATE_LABEL: Record<string, string> = {
  ready: "待执行", running: "执行中", executed: "已完成", failed: "失败", blocked: "预检受阻",
};
export const PLAN_STATE_TONE: Record<string, Tone> = {
  ready: "warn", running: "busy", executed: "ok", failed: "bad", blocked: "bad",
};
/** 计划的终态（**只用于决定停止轮询**；值来自后端，不新增状态）。 */
const PLAN_TERMINAL_STATES = ["executed", "failed", "blocked"];

/** 仍在推进的单元状态（**只用来决定要不要继续轮询**，不是状态机、不推断转移）。 */
const IN_FLIGHT_UNIT_STATES = ["planned", "importing", "import_command_completed", "verifying"];
export function isRunBusy(run: ImportRun | null): boolean {
  return !!run && run.units.some((u) => IN_FLIGHT_UNIT_STATES.includes(u.state));
}

/** 两个单元是否占同一个「槽位」：同一资产 / 同一容器（压缩包）/ 同一条目的同一个包。 */
export function sameSlot(a: WorkbenchItem, b: WorkbenchItem): boolean {
  if (a.assetId !== null && b.assetId !== null && a.assetId === b.assetId) return true;
  if (a.containerPath && b.containerPath && a.containerPath === b.containerPath) return true;
  return a.itemId === b.itemId && (a.packageName ?? "") === (b.packageName ?? "");
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
}) {
  const { plan } = props;
  const units = plan.units;
  const checkedCount = units.filter((u) => props.checks[u.unitId]).length;
  const suggestedCount = units.filter((u) => u.suggested).length;
  const mixedWarning = plan.mixedWarning ?? (anyMixed(units) ? MIXED_WARNING : "");

  return (
    <div className="section" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div className="row" style={{ gap: "6px" }}>
        <b>导入计划 #{plan.id}</b>
        {plan.state ? <Badge tone={PLAN_STATE_TONE[plan.state] ?? "muted"} title={plan.state}>{PLAN_STATE_LABEL[plan.state] ?? plan.state}</Badge> : null}
        <Badge tone={plan.precheck.ok ? "ok" : "warn"}>{plan.precheck.ok ? "预检通过" : "预检有警告"}</Badge>
        {props.jobId !== null && props.jobId !== undefined ? <span className="hint mono">job #{props.jobId}</span> : null}
        <span className="spacer" />
        <span className="hint">已勾选 {checkedCount}/{units.length}</span>
      </div>
      {plan.precheck.errors.map((e, i) => (
        <div className="err" key={"pe" + i}>{e.code}：{e.message}</div>
      ))}
      {plan.precheck.warnings.map((w, i) => (
        <div className="notice" key={"pw" + i}>{w}</div>
      ))}
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
      <div className="row" style={{ gap: "6px" }}>
        <button className="btn primary" disabled={props.busy || checkedCount === 0} onClick={props.onConfirm}>
          {props.busy ? <Spinner /> : null}确认并导入 {checkedCount} 个单元
        </button>
        {suggestedCount > 0 && <span className="hint">「建议」项默认不勾选，需你确认后才加入</span>}
      </div>
    </div>
  );
}

export function AvatarWorkbench(props: {
  onClose: () => void;
  onToast: (kind: "ok" | "bad" | "info", text: string) => void;
}) {
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

  const [picked, setPicked] = useState<WorkbenchItem[]>([]);
  const [projectPath, setProjectPath] = useState("");
  const [projectName, setProjectName] = useState("");
  const [probing, setProbing] = useState(false);

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

  // ① Avatar 列表
  const loadAvatars = useCallback(() => {
    setAvatarsLoading(true); setAvatarsErr("");
    workbenchAvatars()
      .then((list) => {
        setAvatars(list);
        setAvatarId((cur) => (cur === null || !list.some((a) => a.id === cur) ? (list[0]?.id ?? null) : cur));
      })
      .catch((e) => setAvatarsErr(describeError(e)))
      .finally(() => setAvatarsLoading(false));
  }, []);

  useEffect(() => { loadAvatars(); }, [loadAvatars]);

  // ② Unity 工程：尽力自动探测，失败不影响手填
  const probeUnity = useCallback(() => {
    setProbing(true);
    unityStatus()
      .then((s) => {
        const p = s.editor?.projectPath ?? "";
        if (p) { setProjectPath(p); setProjectName(s.editor?.projectName ?? ""); }
        else props.onToast("info", "没探测到打开的 Unity 工程，可手填工程路径");
      })
      .catch(() => { /* Unity 没开是常态，不弹错 */ })
      .finally(() => setProbing(false));
  }, [props]);

  useEffect(() => { probeUnity(); }, [probeUnity]);

  // ③ 素材单元
  const loadItems = useCallback(() => {
    if (avatarId === null) { setItems([]); setItemsTotal(0); return; }
    setItemsLoading(true); setItemsErr("");
    workbenchItems({
      avatarId,
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
      .finally(() => setItemsLoading(false));
  }, [avatarId, debouncedQ, itemStatus, level, policy, confirmedOnly]);

  useEffect(() => { loadItems(); }, [loadItems]);

  // ④ 计划/执行轮询（只在还有在飞单元时跑；页面隐藏时跳过）
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
    setPlanBusy(true); setPlanErr(""); setRuns([]); setRunErr(""); setPollPlanIds([]); setAckedJobs({});
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
        props.onToast("ok", "已生成 " + list.length + " 个导入计划" +
          (list.every((p) => p.precheck.ok) ? "（预检通过）" : "（预检有警告）"));
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
    try {
      const jobs: number[] = [];
      for (const t of targets) {
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
      }
      props.onToast("ok", jobs.length
        ? "已提交执行（job " + jobs.map((n) => "#" + n).join(", ") + "），正在轮询计划/执行状态"
        : "已确认并提交 " + targets.length + " 个计划，正在轮询执行状态");
    } catch (e) {
      props.onToast("bad", "提交执行失败：" + describeError(e));
    } finally {
      setPlanBusy(false);
    }
  };

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
            <div className="hint">① 选择 Avatar（括号内是工作台计数）</div>
            {avatarsErr && <div className="err">工作台接口不可用：{avatarsErr}</div>}
            {avatarsLoading && !avatars.length && <div className="hint"><Spinner /> 载入 Avatar…</div>}
            <div className="preview-list" style={{ maxHeight: "26vh" }}>
              {avatars.map((a) => (
                <button
                  key={a.id}
                  className={"preview-row" + (a.id === avatarId ? " on" : "")}
                  onClick={() => setAvatarId(a.id)}
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
              <button className="btn tiny" onClick={loadItems} disabled={avatarId === null}>刷新</button>
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
                <div className="hint" style={{ padding: "10px" }}>
                  {avatarId === null ? "先选一个 Avatar" : "这个 Avatar 下没有匹配的素材单元"}
                </div>
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
                <button className="btn tiny" onClick={probeUnity} disabled={probing}>探测</button>
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

            {plans.length > 0 && (
              <>
                <div className="hint">④ 计划（suggested 需勾选才入计划）</div>
                {plans.map((p) => (
                  <PlanPanel
                    key={p.id}
                    plan={p}
                    checks={checksOf(p)}
                    onToggle={(uid) => toggleCheck(p.id, uid)}
                    onConfirm={() => void doConfirm()}
                    busy={planBusy}
                    jobId={ackedJobs[p.id] ?? p.jobId}
                  />
                ))}
              </>
            )}

            {(runs.length > 0 || runErr) && (
              <div className="section" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <div className="row" style={{ gap: "6px" }}>
                  <b>⑤ 执行状态</b>
                  {busyRun && <Spinner />}
                  <span className="spacer" />
                </div>
                {runErr && <div className="err">{runErr}</div>}
                {runs.map((run) => (
                  <div key={run.id} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    <div className="row" style={{ gap: "6px" }}>
                      <b className="mono">run #{run.id}</b>
                      <Badge tone="busy">{run.state || "—"}</Badge>
                      <span className="spacer" />
                      <span className="hint">{formatDate(run.startedAt)}{run.finishedAt ? " → " + formatDate(run.finishedAt) : ""}</span>
                    </div>
                    {run.error && <div className="err">{run.error.code}：{run.error.message}</div>}
                    {run.units.map((u) => (
                      <div className="row" key={u.unitId} style={{ gap: "6px", alignItems: "flex-start" }}>
                        <Badge tone={UNIT_STATE_TONE[u.state]}>{UNIT_STATE_LABEL[u.state] ?? u.state}</Badge>
                        <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={u.title}>{u.title}</span>
                        <span className="hint mono" style={{ flex: "0 0 auto" }}>{u.state}</span>
                        {u.error && <span className="err-text" style={{ flex: "0 0 auto" }}>{u.error.code}: {u.error.message}</span>}
                      </div>
                    ))}
                    {!run.units.length && <div className="hint">这个 run 还没有单元</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
