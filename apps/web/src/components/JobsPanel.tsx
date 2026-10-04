import { useState } from "react";
import { IN_FLIGHT_STATES, MAX_ATTEMPTS, TERMINAL_STATES, resolveTransition } from "@core/contracts";
import type { JobRow, JobState } from "@core/contracts";
import { describeError, jobEvents } from "../api";
import { formatDate, stateTone } from "../util";
import { Badge, Spinner } from "./ui";

type Action = "pause" | "resume" | "cancel" | "retry" | "abandon";

/** 用冻结转移表决定按钮可用性：UI 与状态机绝不脱节。 */
export function canDo(state: JobState, action: Action, attempts: number): boolean {
  const ctx = { attempts };
  switch (action) {
    case "pause": return resolveTransition(state, "stop", ctx) !== null || resolveTransition(state, "hold", ctx) !== null;
    case "resume": return resolveTransition(state, "resume", ctx) !== null;
    case "cancel": return resolveTransition(state, "stop", ctx) !== null || resolveTransition(state, "cancel_apply", ctx) !== null;
    case "retry": return resolveTransition(state, "retry", ctx) !== null;
    case "abandon": return resolveTransition(state, "abandon", ctx) !== null || resolveTransition(state, "give_up", ctx) !== null;
  }
}

const KIND_LABEL: Record<string, string> = {
  import_url: "导入链接", import_file: "导入文件", scan: "扫库", reindex: "重解析",
  check_update: "检查更新", download: "下载", match_avatars: "头像匹配",
};

export function JobsPanel(props: {
  jobs: JobRow[];
  loading: boolean;
  auto: boolean;
  onAuto: (v: boolean) => void;
  onRefresh: () => void;
  onAction: (id: number, action: Action) => Promise<string>;
  onToast: (kind: "ok" | "bad" | "info", text: string) => void;
}) {
  const [openEvents, setOpenEvents] = useState<number | null>(null);
  const [events, setEvents] = useState<Record<number, { at: string; from_state: JobState | null; to_state: JobState; event: string; detail: string | null }[]>>({});
  const [busy, setBusy] = useState<number[]>([]);

  const toggleEvents = (id: number) => {
    if (openEvents === id) { setOpenEvents(null); return; }
    setOpenEvents(id);
    jobEvents(id).then((rows) => setEvents((m) => ({ ...m, [id]: rows }))).catch((e) => props.onToast("bad", describeError(e)));
  };

  const act = (id: number, action: Action) => {
    setBusy((b) => [...b, id]);
    props.onAction(id, action)
      .then((msg) => { props.onToast("ok", msg); if (openEvents === id) jobEvents(id).then((rows) => setEvents((m) => ({ ...m, [id]: rows }))).catch(() => { /* 事件可稍后刷新 */ }); })
      .catch((e) => props.onToast("bad", describeError(e)))
      .finally(() => setBusy((b) => b.filter((x) => x !== id)));
  };

  const inFlight = props.jobs.filter((j) => !TERMINAL_STATES.includes(j.state)).length;

  return (
    <>
      <div className="pane-head">
        <h2>作业</h2>
        <span className="hint">{inFlight} 进行中 / {props.jobs.length}</span>
        <label className="chk" title="每 3 秒 GET /jobs">
          <input type="checkbox" checked={props.auto} onChange={(e) => props.onAuto(e.target.checked)} />自动
        </label>
        <button className="btn tiny" onClick={props.onRefresh}>刷新</button>
      </div>
      <div className="col-scroll">
        <div className="pane-body" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {props.loading && !props.jobs.length && <div className="hint"><Spinner /> 载入作业…</div>}
          {!props.loading && !props.jobs.length && <div className="empty">暂无作业</div>}
          {props.jobs.map((j) => (
            <div className="job" key={j.id}>
              <div className="top">
                <span className="id">#{j.id}</span>
                <Badge tone={stateTone(j.state)}>{j.state}</Badge>
                <span className="hint">{KIND_LABEL[j.kind] ?? j.kind}</span>
                <span className="spacer" />
                <span className="hint" title={"attempts / MAX_ATTEMPTS=" + MAX_ATTEMPTS}>尝试 {j.attempts}/{MAX_ATTEMPTS}</span>
              </div>
              <div className="hint mono" style={{ wordBreak: "break-all" }}>{j.payload ?? "—"}</div>
              {j.item_id !== null && <div className="hint">item #{j.item_id}</div>}
              {j.error && <div className="err-text">{j.error}</div>}
              <div className="ops">
                <button className="btn tiny" disabled={busy.includes(j.id) || !canDo(j.state, "pause", j.attempts)} onClick={() => act(j.id, "pause")} title="stop → releasing（hold）">暂停</button>
                <button className="btn tiny" disabled={busy.includes(j.id) || !canDo(j.state, "resume", j.attempts)} onClick={() => act(j.id, "resume")} title="resume → queued">继续</button>
                <button className="btn tiny danger" disabled={busy.includes(j.id) || !canDo(j.state, "cancel", j.attempts)} onClick={() => act(j.id, "cancel")} title="stop / cancel_apply → cancelled">取消</button>
                <button className="btn tiny" disabled={busy.includes(j.id) || !canDo(j.state, "retry", j.attempts)} onClick={() => act(j.id, "retry")} title={"retry → queued（attempts<" + MAX_ATTEMPTS + "），次数用尽则 → abandoned"}>重试</button>
                <button className="btn tiny" disabled={busy.includes(j.id) || !canDo(j.state, "abandon", j.attempts)} onClick={() => act(j.id, "abandon")} title="abandon / give_up → abandoned">放弃</button>
                <span className="spacer" />
                <button className="btn tiny ghost" onClick={() => toggleEvents(j.id)}>{openEvents === j.id ? "收起" : "事件"}</button>
                {busy.includes(j.id) && <Spinner />}
              </div>
              <div className="hint">{formatDate(j.created_at)}{j.finished_at ? " → " + formatDate(j.finished_at) : ""}</div>
              {openEvents === j.id && (
                <div className="events">
                  {(events[j.id] ?? []).map((e, i) => (
                    <div key={i}>{formatDate(e.at)} {e.from_state ?? "∅"} → ({e.event}) → {e.to_state}{e.detail ? " :: " + e.detail : ""}</div>
                  ))}
                  {!(events[j.id] ?? []).length && <div>（无事件）</div>}
                </div>
              )}
            </div>
          ))}
          <div className="hint">可选状态：{IN_FLIGHT_STATES.join(" / ")} / {TERMINAL_STATES.join(" / ")} / paused / failed</div>
        </div>
      </div>
    </>
  );
}
