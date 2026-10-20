import { useCallback, useEffect, useRef, useState } from "react";
import type { PipelineEvent, PipelineOverview, PipelineStage, PipelineTask } from "../types";
import {
  boostPipelineAsset, cancelPipelineTask, describeError, gcPipeline, getPipeline,
  listPipelineEvents, listPipelineTasks, pausePipeline, reindexPipelineAsset, resumePipeline, retryPipelineTask,
} from "../api";
import { formatBytes, formatDate, shortenPath } from "../util";
import { Badge, Collapsible, Section, Spinner } from "./ui";

/**
 * 索引流水线监控（v0.6.0 §13）。
 * 与「作业」面板并列：作业是**条目级**的一次性任务，流水线是**资产级**的分阶段队列。
 * 数据全部走 api.ts（组件不直接 fetch）；轮询 2s，页面不可见时跳过（后台标签页不烧 IO）。
 */

export const PIPELINE_STAGE_ORDER: PipelineStage[] = ["hash", "archive", "unitypackage", "thumbs", "meta", "categorize", "fts"];
export const PIPELINE_STAGE_LABEL: Record<string, string> = {
  hash: "哈希", archive: "压缩包", unitypackage: "unitypackage", thumbs: "缩略图",
  meta: "元数据", categorize: "分类", fts: "全文索引",
};
export const PIPELINE_STATE_LABEL: Record<string, string> = {
  queued: "排队", running: "执行", waiting_retry: "等待重试",
  failed: "失败", done: "完成", cancelled: "取消", skipped: "跳过",
};

type Tone = "ok" | "warn" | "bad" | "busy" | "muted" | "violet" | "";
export function pipelineStateTone(state: string): Tone {
  if (state === "done") return "ok";
  if (state === "failed") return "bad";
  if (state === "waiting_retry") return "warn";
  if (state === "running") return "busy";
  if (state === "cancelled" || state === "skipped") return "muted";
  return "";
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  const m = Math.floor(ms / 60000);
  return m + "m" + Math.round((ms % 60000) / 1000) + "s";
}
/** 距今多久（用于「已运行」与任务年龄）。 */
export function fmtAge(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const ms = Date.now() - t;
  if (ms <= 0) return "0s";
  if (ms < 60000) return Math.floor(ms / 1000) + "s";
  if (ms < 3600000) return Math.floor(ms / 60000) + "m";
  return Math.floor(ms / 3600000) + "h" + Math.floor((ms % 3600000) / 60000) + "m";
}
/** 进度条：优先字节（下载/哈希/解包），否则条目数（元数据/分类）。 */
export function progressOf(t: PipelineTask): { pct: number; text: string } {
  if (t.bytes_total && t.bytes_total > 0) {
    return { pct: Math.max(0, Math.min(100, (t.bytes_done / t.bytes_total) * 100)), text: formatBytes(t.bytes_done) + " / " + formatBytes(t.bytes_total) };
  }
  if (t.items_total && t.items_total > 0) {
    return { pct: Math.max(0, Math.min(100, (t.items_done / t.items_total) * 100)), text: t.items_done + " / " + t.items_total + " 项" };
  }
  if (t.bytes_done > 0) return { pct: 0, text: formatBytes(t.bytes_done) };
  if (t.items_done > 0) return { pct: 0, text: t.items_done + " 项" };
  return { pct: 0, text: "" };
}

interface TaskRowProps {
  t: PipelineTask;
  events: PipelineEvent[];
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onRetry: () => void;
  onCancel: () => void;
  onReindex: () => void;
  onBoost: () => void;
}

function TaskRow(props: TaskRowProps) {
  const t = props.t;
  const pr = progressOf(t);
  const terminal = t.state === "done" || t.state === "cancelled" || t.state === "skipped";
  return (
    <div className="pipe-task">
      <div className="top">
        <span className="mono hint">#{t.id}</span>
        <span className="hint">{PIPELINE_STAGE_LABEL[t.stage] ?? t.stage}</span>
        <Badge tone={pipelineStateTone(t.state)} title={t.state}>{PIPELINE_STATE_LABEL[t.state] ?? t.state}</Badge>
        {t.attempts > 0 && <span className="hint">重试 {t.attempts}/{t.max_attempts || "?"}</span>}
        <span className="spacer" />
        <span className="mono hint">资产 #{t.asset_id}</span>
      </div>
      {t.path && <div className="hint mono" style={{ wordBreak: "break-all" }}>{shortenPath(t.path, 96)}</div>}
      {pr.text && <div className="pipe-bar"><i style={{ width: pr.pct + "%" }} /></div>}
      {pr.text && <div className="hint mono">{pr.text}</div>}
      {t.error && (
        <div className="err-text" title={t.error}>
          {t.error_code ? "[" + t.error_code + "] " : ""}{t.error}
        </div>
      )}
      <div className="row wrap" style={{ gap: "5px" }}>
        <button className="btn tiny" disabled={props.busy || terminal} onClick={props.onRetry} title="POST /pipeline/tasks/:id/retry">重试</button>
        <button className="btn tiny danger" disabled={props.busy || terminal} onClick={props.onCancel} title="POST /pipeline/tasks/:id/cancel">取消</button>
        <button className="btn tiny ghost" disabled={props.busy} onClick={props.onReindex} title="POST /pipeline/assets/:id/reindex —— 整资产重排全部阶段">重排</button>
        <button className="btn tiny ghost" disabled={props.busy} onClick={props.onBoost} title="POST /pipeline/assets/:id/boost —— 提到队头">优先</button>
        <button className="btn tiny ghost" onClick={props.onToggle}>{props.open ? "收起" : "详情"}</button>
        {props.busy && <Spinner />}
      </div>
      {props.open && (
        <div style={{ marginTop: "3px", display: "flex", flexDirection: "column", gap: "3px" }}>
          <div className="hint mono">创建 {formatDate(t.created_at)} · 开始 {t.started_at ? formatDate(t.started_at) : "—"} · 结束 {t.finished_at ? formatDate(t.finished_at) : "—"}</div>
          <div className="hint mono">
            优先级 {t.priority} · 条目 {t.item_id === null ? "—" : "#" + t.item_id}
            {t.size !== null && t.size !== undefined ? " · 大小 " + formatBytes(t.size) : ""}
            {t.next_retry_at ? " · 下次重试 " + formatDate(t.next_retry_at) : ""}
          </div>
          <div className="hint">事件{props.events.length ? "（最近 " + props.events.length + " 条）" : ""}</div>
          <div className="pipe-ev">
            {props.events.length
              ? props.events.map((e) => (
                  <div key={e.id}>
                    {formatDate(e.at)} {e.event}
                    {e.stage ? " · " + (PIPELINE_STAGE_LABEL[e.stage] ?? e.stage) : ""}
                    {e.detail ? " :: " + e.detail : ""}
                  </div>
                ))
              : <div>（暂无事件）</div>}
          </div>
        </div>
      )}
    </div>
  );
}

const STATE_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部" },
  { value: "running", label: "执行" },
  { value: "queued", label: "排队" },
  { value: "waiting_retry", label: "重试" },
  { value: "failed", label: "失败" },
];

export function PipelinePanel(props: { onToast: (kind: "ok" | "bad" | "info", text: string) => void }) {
  const [ov, setOv] = useState<PipelineOverview | null>(null);
  const [tasks, setTasks] = useState<PipelineTask[]>([]);
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [auto, setAuto] = useState(true);
  const [stateFilter, setStateFilter] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [openTask, setOpenTask] = useState<number | null>(null);
  const [busy, setBusy] = useState<string[]>([]);
  const [updatedAt, setUpdatedAt] = useState("");
  const running = useRef(false);

  const refresh = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      // 三个请求互不拖累：总览挂了也要能看任务列表（反之亦然）。
      const [o, ts, es] = await Promise.allSettled([
        getPipeline(),
        listPipelineTasks({ state: stateFilter || undefined, stage: stageFilter || undefined, limit: 50 }),
        listPipelineEvents(0, 200),
      ]);
      if (o.status === "fulfilled") setOv(o.value);
      if (ts.status === "fulfilled") setTasks(ts.value);
      if (es.status === "fulfilled") setEvents(es.value);
      if (o.status === "fulfilled") setErr("");
      else setErr(describeError(o.reason));
      setUpdatedAt(new Date().toISOString());
    } finally {
      running.current = false;
      setLoading(false);
    }
  }, [stateFilter, stageFilter]);

  useEffect(() => {
    void refresh();
    if (!auto) return;
    const tick = (): void => {
      // 后台标签页不轮询：面板可能一直挂在侧栏
      const hidden = typeof document !== "undefined" && document.hidden;
      if (!hidden) void refresh();
    };
    const timer = setInterval(tick, 2000);
    const onVisible = (): void => { if (typeof document === "undefined" || !document.hidden) void refresh(); };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    if (typeof window !== "undefined") window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(timer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      if (typeof window !== "undefined") window.removeEventListener("focus", onVisible);
    };
  }, [auto, refresh]);

  const isBusy = (key: string): boolean => busy.includes(key);
  /** 统一动作壳：加锁 → 调 API → toast → 刷新（失败只弹错，不清空已有数据）。 */
  const run = <T,>(key: string, start: () => Promise<T>, done: (r: T) => string): void => {
    setBusy((b) => (b.includes(key) ? b : [...b, key]));
    start()
      .then((r) => { props.onToast("ok", done(r)); void refresh(); })
      .catch((e) => props.onToast("bad", describeError(e)))
      .finally(() => setBusy((b) => b.filter((x) => x !== key)));
  };

  const stageRows = ov && ov.stages.length
    ? ov.stages
    : PIPELINE_STAGE_ORDER.map((s) => ({ stage: s, queued: 0, running: 0, waitingRetry: 0, failed: 0, done: 0, skipped: 0, avgMs: null as number | null }));
  const hitPct = ov ? (ov.cache.hitRate <= 1 ? ov.cache.hitRate * 100 : ov.cache.hitRate) : 0;
  const cachePct = ov && ov.cache.maxBytes > 0 ? Math.min(100, (ov.cache.bytes / ov.cache.maxBytes) * 100) : 0;
  const failedTasks = tasks.filter((t) => t.state === "failed").slice(0, 5);
  const eventsOf = (id: number): PipelineEvent[] => events.filter((e) => e.task_id === id).slice(-12);
  const nonDefault = ov ? Object.entries(ov.nonDefaultLimits) : [];

  return (
    <div className="col-scroll">
      <div className="pane-body" style={{ display: "flex", flexDirection: "column", gap: "9px" }}>
        {/* 控制条 */}
        <div className="row wrap" style={{ gap: "6px" }}>
          <Badge tone={!ov ? "" : !ov.started ? "muted" : ov.paused ? "warn" : "ok"}>
            {!ov ? "未知" : !ov.started ? "未启动" : ov.paused ? "已暂停" : "运行中"}
          </Badge>
          <span className="hint" title={updatedAt ? "最后刷新 " + formatDate(updatedAt) : ""}>
            处理 {ov?.processed ?? 0} · 失败 {ov?.failures ?? 0}
          </span>
          <span className="spacer" />
          <button
            className="btn tiny"
            disabled={!ov || isBusy("pipe")}
            onClick={() => run("pipe", () => (ov?.paused ? resumePipeline() : pausePipeline()), (r) => (r.paused ? "流水线已暂停" : "流水线已继续"))}
          >
            {ov?.paused ? "继续" : "暂停"}
          </button>
          <button
            className="btn tiny"
            disabled={isBusy("gc")}
            onClick={() => run("gc", gcPipeline, (r) => "缓存回收 " + r.removed + " 项 / " + formatBytes(r.bytes))}
            title="POST /pipeline/gc"
          >
            回收缓存
          </button>
          <button className="btn tiny ghost" onClick={() => void refresh()}>刷新</button>
          <label className="chk" title="每 2 秒轮询；页面不可见时自动暂停">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />自动
          </label>
        </div>

        {err && <div className="err">流水线接口不可用：{err}</div>}
        {loading && !ov && <div className="hint"><Spinner /> 载入流水线…</div>}

        {/* 总览计数 */}
        <div className="pipe-stats">
          <div className="pipe-stat busy"><b>{ov?.running ?? 0}</b><span>执行中</span></div>
          <div className="pipe-stat"><b>{ov?.queued ?? 0}</b><span>排队</span></div>
          <div className={"pipe-stat" + ((ov?.waitingRetry ?? 0) > 0 ? " warn" : "")}><b>{ov?.waitingRetry ?? 0}</b><span>等待重试</span></div>
          <div className={"pipe-stat" + ((ov?.failed ?? 0) > 0 ? " bad" : "")}><b>{ov?.failed ?? 0}</b><span>失败</span></div>
          <div className="pipe-stat ok"><b>{ov?.done ?? 0}</b><span>完成</span></div>
          <div className="pipe-stat"><b>{ov?.cancelled ?? 0}</b><span>取消</span></div>
          <div className="pipe-stat"><b>{ov?.skipped ?? 0}</b><span>跳过</span></div>
          <div className="pipe-stat"><b>{ov ? fmtAge(ov.startedAt) : "—"}</b><span>已运行</span></div>
        </div>

        {/* 阶段 */}
        <Section title="阶段" right={<span className="hint">均耗时取已结束任务</span>}>
          <table className="pipe-table">
            <thead>
              <tr><th>阶段</th><th>执行</th><th>排队</th><th>重试</th><th>失败</th><th>完成</th><th>跳过</th><th>均耗时</th></tr>
            </thead>
            <tbody>
              {stageRows.map((s) => (
                <tr key={s.stage} className={s.failed > 0 ? "hot" : ""}>
                  <td>{PIPELINE_STAGE_LABEL[s.stage] ?? s.stage}</td>
                  <td>{s.running}</td>
                  <td>{s.queued}</td>
                  <td>{s.waitingRetry}</td>
                  <td>{s.failed}</td>
                  <td>{s.done}</td>
                  <td>{s.skipped}</td>
                  <td>{fmtMs(s.avgMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        {/* 缓存 / 内存 */}
        <Section title="缓存 / 内存">
          <div className="pipe-kv"><span className="hint">命中率</span><b>{ov ? hitPct.toFixed(1) + "%" : "—"}</b></div>
          <div className="pipe-kv"><span className="hint">命中 / 条目</span><span className="mono">{ov ? ov.cache.hits + " / " + ov.cache.entries : "—"}</span></div>
          <div className="pipe-bar" title={ov ? formatBytes(ov.cache.bytes) + " / " + formatBytes(ov.cache.maxBytes) : ""}>
            <i style={{ width: cachePct + "%" }} />
          </div>
          <div className="pipe-kv"><span className="hint">缓存占用</span><span className="mono">{ov ? formatBytes(ov.cache.bytes) + " / " + formatBytes(ov.cache.maxBytes) : "—"}</span></div>
          <div className="pipe-kv"><span className="hint">内存 RSS</span><span className="mono">{ov ? formatBytes(ov.memory.rss) : "—"}</span></div>
          <div className="pipe-kv"><span className="hint">堆 used / total</span><span className="mono">{ov ? formatBytes(ov.memory.heapUsed) + " / " + formatBytes(ov.memory.heapTotal) : "—"}</span></div>
          <div className="pipe-kv"><span className="hint">external</span><span className="mono">{ov ? formatBytes(ov.memory.external) : "—"}</span></div>
        </Section>

        {/* 最近失败 */}
        <Section title="最近失败" right={<span className="hint">{failedTasks.length ? failedTasks.length + " 条" : "无"}</span>}>
          {ov?.lastError && (
            <div className="pipe-fail">
              <div>
                {formatDate(ov.lastError.at)} · {PIPELINE_STAGE_LABEL[ov.lastError.stage] ?? ov.lastError.stage} · 资产 #{ov.lastError.assetId}
              </div>
              <div className="mono" style={{ wordBreak: "break-all" }}>{ov.lastError.message}</div>
            </div>
          )}
          {failedTasks.map((t) => (
            <div key={t.id} style={{ marginTop: ov?.lastError ? "6px" : 0 }}>
              <TaskRow
                t={t}
                events={eventsOf(t.id)}
                open={openTask === t.id}
                busy={isBusy("task:" + t.id)}
                onToggle={() => setOpenTask((v) => (v === t.id ? null : t.id))}
                onRetry={() => run("task:" + t.id, () => retryPipelineTask(t.id), (r) => "任务 #" + r.id + " 已重排（" + r.state + "）")}
                onCancel={() => run("task:" + t.id, () => cancelPipelineTask(t.id), (r) => "任务 #" + r.id + " → " + r.state)}
                onReindex={() => run("asset:" + t.asset_id, () => reindexPipelineAsset(t.asset_id), (r) => "资产 #" + t.asset_id + " 重排 " + r.queued + " 个阶段")}
                onBoost={() => run("asset:" + t.asset_id, () => boostPipelineAsset(t.asset_id), (r) => "资产 #" + t.asset_id + " 提升 " + r.boosted + " 个任务")}
              />
            </div>
          ))}
          {!ov?.lastError && !failedTasks.length && <div className="hint">没有失败记录</div>}
        </Section>

        {/* 队列 / 任务列表 */}
        <Section
          title="任务"
          right={
            <span className="hint">{tasks.length}{tasks.length >= 50 ? "+ (limit 50)" : ""} 条</span>
          }
        >
          <div className="row wrap" style={{ gap: "5px", marginBottom: "6px" }}>
            <div className="seg">
              {STATE_FILTERS.map((f) => (
                <button key={f.value} className={stateFilter === f.value ? "on" : ""} onClick={() => setStateFilter(f.value)}>{f.label}</button>
              ))}
            </div>
            <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} style={{ maxWidth: "120px" }} title="按阶段过滤">
              <option value="">全部阶段</option>
              {PIPELINE_STAGE_ORDER.map((s) => <option key={s} value={s}>{PIPELINE_STAGE_LABEL[s]}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {loading && !tasks.length && <div className="hint"><Spinner /> 载入任务…</div>}
            {!loading && !tasks.length && <div className="empty">没有匹配的任务</div>}
            {tasks.map((t) => (
              <TaskRow
                key={t.id}
                t={t}
                events={eventsOf(t.id)}
                open={openTask === t.id}
                busy={isBusy("task:" + t.id)}
                onToggle={() => setOpenTask((v) => (v === t.id ? null : t.id))}
                onRetry={() => run("task:" + t.id, () => retryPipelineTask(t.id), (r) => "任务 #" + r.id + " 已重排（" + r.state + "）")}
                onCancel={() => run("task:" + t.id, () => cancelPipelineTask(t.id), (r) => "任务 #" + r.id + " → " + r.state)}
                onReindex={() => run("asset:" + t.asset_id, () => reindexPipelineAsset(t.asset_id), (r) => "资产 #" + t.asset_id + " 重排 " + r.queued + " 个阶段")}
                onBoost={() => run("asset:" + t.asset_id, () => boostPipelineAsset(t.asset_id), (r) => "资产 #" + t.asset_id + " 提升 " + r.boosted + " 个任务")}
              />
            ))}
          </div>
        </Section>

        {/* 非默认限制（只在被改过时出现） */}
        {nonDefault.length > 0 && (
          <Collapsible label={"非默认限制（" + nonDefault.length + "）"} count={nonDefault.length}>
            <div className="mono hint" style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              {nonDefault.map(([k, v]) => <span key={k}>{k} = {String(v)}</span>)}
            </div>
          </Collapsible>
        )}

        <div className="hint">阶段顺序 {PIPELINE_STAGE_ORDER.map((s) => PIPELINE_STAGE_LABEL[s]).join(" → ")}</div>
      </div>
    </div>
  );
}
