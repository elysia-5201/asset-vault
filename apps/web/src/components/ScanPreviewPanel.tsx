import { useCallback, useEffect, useState } from "react";
import {
  applyScanPreview, cancelScanPreview, createScanPreview, decideScanPreviewItems, deleteScanPreview,
  describeError, getScanPreview, listScanPreviewItems, listScanPreviews, retryScanPreview,
} from "../api";
import type { LibraryRootRow, ScanPreview, ScanPreviewItem } from "../types";
import { formatBytes, shortenPath } from "../util";
import { Badge, Spinner } from "./ui";

const APPLICABLE = ["new", "changed", "duplicate_suspected", "missing"] as const;

const CHANGE_LABEL: Record<string, string> = {
  new: "新增", unchanged: "未变", changed: "已变化", missing: "缺失",
  duplicate_suspected: "疑似重复", unreadable: "不可读", error: "错误",
};
const CHANGE_TONE: Record<string, "ok" | "warn" | "bad" | "busy" | "muted"> = {
  new: "ok", unchanged: "muted", changed: "warn", missing: "bad",
  duplicate_suspected: "busy", unreadable: "muted", error: "bad",
};
const STATE_LABEL: Record<string, string> = {
  scanning: "扫描中", ready: "可应用", partial: "部分完整", failed: "失败",
  applying: "应用中", applied: "已应用", partially_applied: "部分应用",
  cancelled: "已取消", expired: "已过期",
};
const STATE_TONE: Record<string, "ok" | "warn" | "bad" | "busy" | "muted"> = {
  scanning: "busy", ready: "ok", partial: "warn", failed: "bad", applying: "busy",
  applied: "ok", partially_applied: "warn", cancelled: "muted", expired: "muted",
};
const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");

/**
 * 「扫描变更中心」：先把一轮扫描的**变化清单**落库，逐条确认后再应用。
 * 只做 登记新文件 / 重新索引变化文件 / 把确认缺失的资产标 missing；
 * 不移动、不删除源文件，也不自动合并重复项（疑似重复只是提示）。
 * 后端端点不可用（旧后端 / mock）时显示明确提示，不假装成功。
 */
export function ScanPreviewPanel(props: {
  roots: LibraryRootRow[];
  onClose: () => void;
  onToast: (kind: "ok" | "bad" | "info", text: string) => void;
  onChanged: () => void;
}) {
  const [list, setList] = useState<ScanPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<ScanPreview | null>(null);
  const [items, setItems] = useState<ScanPreviewItem[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [busy, setBusy] = useState("");
  const [rootId, setRootId] = useState<number | "">(props.roots[0]?.id ?? "");
  const [deep, setDeep] = useState(true);

  const loadList = useCallback((selectId?: number) => {
    setLoading(true); setErr("");
    return listScanPreviews(40)
      .then((r) => {
        setList(r.previews);
        const want = selectId ?? sel?.id ?? r.previews[0]?.id;
        const p = r.previews.find((x) => x.id === want) ?? r.previews[0] ?? null;
        if (p) void openPreview(p.id);
      })
      .catch((e) => { setErr(describeError(e)); setList([]); })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.id]);

  const openPreview = useCallback((id: number) => {
    setFilter("");
    return Promise.all([getScanPreview(id), listScanPreviewItems(id, { limit: 100 })])
      .then(([d, page]) => { setSel(d.preview); setItems(page.items); setCursor(page.nextCursor); })
      .catch((e) => { setErr(describeError(e)); });
  }, []);

  useEffect(() => { void loadList(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  /** 扫描中 / 应用中：轮询详情；状态落定后刷新条目与列表。 */
  useEffect(() => {
    if (!sel || !["scanning", "applying"].includes(sel.state)) return;
    const t = setInterval(() => {
      getScanPreview(sel.id).then((d) => {
        setSel(d.preview);
        if (!["scanning", "applying"].includes(d.preview.state)) {
          void openPreview(d.preview.id);
          void loadList(d.preview.id);
          if (d.preview.state.startsWith("applied") || d.preview.state === "partially_applied") props.onChanged();
        }
      }).catch(() => { /* 轮询失败静默，下一次再试 */ });
    }, 1500);
    return () => clearInterval(t);
  }, [sel, openPreview, loadList, props]);

  const run = (label: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    fn().catch((e) => props.onToast("bad", label + "失败：" + describeError(e))).finally(() => setBusy(""));
  };

  const doCreate = () => run("生成预览", async () => {
    if (rootId === "") { props.onToast("bad", "请选择一个库根"); return; }
    const r = await createScanPreview({ rootId: Number(rootId), deep });
    props.onToast("ok", r.existing ? "已有同参数的活跃预览，直接打开" : "已开始扫描（预览生成中）");
    await loadList(r.previewId);
    if (!items.length) await openPreview(r.previewId);
  });

  const doDecide = (item: ScanPreviewItem, accept: boolean) => run("勾选", async () => {
    await decideScanPreviewItems(sel!.id, { keys: [item.item_key], decision: accept ? "accept" : "skip" });
    setItems((xs) => xs.map((x) => (x.id === item.id ? { ...x, decision: accept ? "accept" : "skip" } : x)));
  });

  const doAcceptAll = () => run("全选可应用", async () => {
    let n = 0;
    for (const c of APPLICABLE) {
      const r = await decideScanPreviewItems(sel!.id, { change: c, decision: "accept" });
      n += r.updated;
    }
    props.onToast(n ? "ok" : "info", n ? "已勾选 " + n + " 条可应用项" : "没有可勾选的条目");
    await openPreview(sel!.id);
  });

  const doApply = () => run("应用", async () => {
    const p = sel!;
    if (!window.confirm("将应用预览 #" + p.id + " 中已勾选的条目（新增/变化/确认缺失）。\n不移动、不删除源文件；疑似重复不会自动合并。继续？")) return;
    const r = await applyScanPreview(p.id, { planHash: p.plan_hash ?? undefined });
    props.onToast("ok", "已提交应用：文件 " + r.files + " 条 / 缺失 " + r.missing + " 条 / 过期跳过 " + r.stale + " 条");
    await openPreview(p.id);
    void loadList(p.id);
  });

  const doCancel = () => run("取消", async () => {
    await cancelScanPreview(sel!.id);
    props.onToast("info", "预览已取消（保留已生成的结果）");
    await loadList(sel!.id);
  });

  const doRetry = () => run("重试", async () => {
    const r = await retryScanPreview(sel!.id);
    props.onToast("ok", "已重试失败的 " + r.retried + " 条（文件 " + r.files + " / 缺失 " + r.missing + " / 过期 " + r.stale + "）");
    await openPreview(sel!.id);
    void loadList(sel!.id);
  });

  const doDelete = () => run("删除", async () => {
    if (!window.confirm("删除预览 #" + sel!.id + "？（只删预览记录，不动素材）")) return;
    await deleteScanPreview(sel!.id);
    props.onToast("info", "预览已删除");
    setSel(null); setItems([]);
    await loadList();
  });

  const changeFilter = (c: string) => run("筛选", async () => {
    setFilter(c);
    const page = await listScanPreviewItems(sel!.id, { limit: 100, change: c || undefined });
    setItems(page.items); setCursor(page.nextCursor);
  });

  const loadMore = () => run("加载更多", async () => {
    const page = await listScanPreviewItems(sel!.id, { limit: 100, cursor, change: filter || undefined });
    setItems((xs) => [...xs, ...page.items]); setCursor(page.nextCursor);
  });

  const counts = sel?.counts ?? null;
  const applicable = counts ? APPLICABLE.reduce((n, c) => n + (counts[c] ?? 0), 0) : 0;

  return (
    <div className="backdrop" onClick={props.onClose}>
      <div className="drawer" role="dialog" aria-label="扫描变更中心" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>扫描变更中心</h3>
          <Badge tone="muted">先预览 · 再确认 · 才写库</Badge>
          <span className="spacer" />
          {(busy || loading) && <Spinner />}
          <button className="btn" onClick={props.onClose}>关闭</button>
        </div>

        <div className="preview-body">
          <div className="left">
            <div className="section">
              <div className="hint" style={{ marginBottom: "6px" }}>生成新预览</div>
              <select value={rootId} onChange={(e) => setRootId(e.target.value === "" ? "" : Number(e.target.value))} style={{ width: "100%" }}>
                <option value="">（选择库根）</option>
                {props.roots.map((r) => <option key={r.id} value={r.id}>#{r.id} {shortenPath(r.path, 34)}</option>)}
              </select>
              <label className="row" style={{ marginTop: "6px", gap: "5px", cursor: "pointer" }}>
                <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} /> 深度扫描（最大 10 层）
              </label>
              <button className="btn" style={{ marginTop: "8px", width: "100%" }} disabled={!!busy} onClick={doCreate}>生成预览</button>
              <div className="hint" style={{ marginTop: "6px" }}>只读：生成阶段不写任何素材，只写预览清单。</div>
            </div>

            <div className="row" style={{ gap: "6px" }}>
              <span className="hint">最近预览</span>
              <span className="spacer" />
              <button className="btn tiny" onClick={() => void loadList()} disabled={!!busy}>刷新</button>
            </div>
            {list.map((p) => (
              <button key={p.id} className={"preview-row" + (sel?.id === p.id ? " on" : "")} onClick={() => void openPreview(p.id)} title={p.path}>
                <span className="row" style={{ gap: "6px" }}>
                  <Badge tone={STATE_TONE[p.state] ?? "muted"}>{STATE_LABEL[p.state] ?? p.state}</Badge>
                  <span className="hint mono">#{p.id}</span>
                  <span className="spacer" />
                  <span className="hint">{fmtDate(p.created_at)}</span>
                </span>
                <span className="hint" style={{ wordBreak: "break-all" }}>{shortenPath(p.path, 44)}</span>
                <span className="hint">
                  新增 {p.counts?.new ?? 0} · 变化 {p.counts?.changed ?? 0} · 缺失 {p.counts?.missing ?? 0}
                  {p.counts?.duplicate_suspected ? " · 疑似 " + p.counts.duplicate_suspected : ""}
                </span>
              </button>
            ))}
            {!loading && !list.length && <div className="empty">还没有预览<br /><span className="hint">在上面选一个库根，点「生成预览」。</span></div>}
          </div>

          <div className="right">
            {err && <div className="notice bad">变更中心接口不可用（后端版本较旧？）：{err}</div>}
            {!sel && !err && <div className="empty">左侧选择一个预览查看详情</div>}
            {sel && (
              <>
                <div className="row wrap" style={{ gap: "6px" }}>
                  <b>#{sel.id}</b>
                  <Badge tone={STATE_TONE[sel.state] ?? "muted"}>{STATE_LABEL[sel.state] ?? sel.state}</Badge>
                  {sel.truncated ? <Badge tone="warn">扫描被截断</Badge> : null}
                  {!sel.complete && sel.state !== "failed" ? <Badge tone="warn">本轮不完整（未提出缺失项）</Badge> : null}
                  <span className="spacer" />
                  <span className="hint">文件 {sel.files} · 目录 {sel.dirs} · {formatBytes(sel.bytes)} · 错误 {sel.error_count}</span>
                </div>
                <div className="hint mono" style={{ wordBreak: "break-all" }}>{sel.path}（{sel.deep ? "深度 10" : "深度 6"}）</div>
                {sel.error && <div className="notice bad">{sel.error}</div>}
                {sel.scan && sel.scan.missingProposed === false && (
                  <div className="notice">本轮扫描不完整（{sel.scan.reasons?.join(" / ") || "存在读取错误"}）：**不提出缺失项**，请修好可读性后重新扫描。</div>
                )}

                <div className="row wrap" style={{ gap: "6px" }}>
                  <button className={"cat-chip" + (filter === "" ? " on" : "")} onClick={() => void changeFilter("")}>全部 {counts?.total ?? 0}</button>
                  {(Object.keys(CHANGE_LABEL) as string[]).map((c) => (
                    <button key={c} className={"cat-chip" + (filter === c ? " on" : "")} onClick={() => void changeFilter(c)}>
                      {CHANGE_LABEL[c]} {counts ? (counts as any)[c] ?? 0 : 0}
                    </button>
                  ))}
                </div>

                <div className="row" style={{ gap: "6px" }}>
                  <span className="hint">已勾选 {sel.itemCounts.accepted} · 已应用 {sel.itemCounts.applied} · 未应用 {sel.itemCounts.pending}</span>
                  <span className="spacer" />
                  <button className="btn tiny" disabled={!!busy || !["ready", "partial"].includes(sel.state)} onClick={doAcceptAll}>全选可应用（{applicable}）</button>
                  <button className="btn tiny" disabled={!!busy || !["ready", "partial"].includes(sel.state)} onClick={doApply}>应用已勾选</button>
                  <button className="btn tiny" disabled={!!busy || sel.state === "applying"} onClick={doRetry}>重试失败项</button>
                  <button className="btn tiny" disabled={!!busy || sel.state === "applying"} onClick={doCancel}>取消</button>
                  <button className="btn tiny" disabled={!!busy || sel.state === "applying"} onClick={doDelete}>删除预览</button>
                </div>

                <div className="preview-list">
                  {items.map((it) => (
                    <div className="preview-item" key={it.id}>
                      <input type="checkbox" disabled={!!busy || it.applied === 1 || !APPLICABLE.includes(it.change as any)}
                        checked={it.decision === "accept"} onChange={(e) => void doDecide(it, e.target.checked)} />
                      <Badge tone={CHANGE_TONE[it.change] ?? "muted"}>{CHANGE_LABEL[it.change] ?? it.change}</Badge>
                      <span className="p mono" title={it.path}>{shortenPath(it.path, 80)}</span>
                      <span className="hint">
                        {it.applied === 1 ? "已应用" : it.error ? it.error : it.size != null ? formatBytes(it.size) : ""}
                      </span>
                    </div>
                  ))}
                  {!items.length && <div className="empty">这个筛选下没有条目</div>}
                </div>
                {cursor && <button className="btn tiny" onClick={loadMore} disabled={!!busy}>加载更多</button>}

                {sel.state === "applied" && <div className="notice">已全部应用。素材现在可以在列表里看到（可回列表刷新）。</div>}
                {sel.state === "partially_applied" && <div className="notice">部分应用：失败项可以点「重试失败项」；文件已变化的项需要重新扫描。</div>}
                {sel.state === "expired" && <div className="notice">预览已过期（超过 24h），请重新生成。</div>}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
