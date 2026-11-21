import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyScanPreview, cancelScanPreview, createScanPreview, decideScanPreviewItems, deleteScanPreview,
  describeError, getScanPreview, listScanPreviewItems, listScanPreviews, retryScanPreview, scan,
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
  initialRootId?: number;
  onJobsChanged?: () => void;
}) {
  const [list, setList] = useState<ScanPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<ScanPreview | null>(null);
  const [items, setItems] = useState<ScanPreviewItem[]>([]);
  const [openingId, setOpeningId] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [filter, setFilter] = useState<string>("changes");
  const [busy, setBusy] = useState("");
  const [rootId, setRootId] = useState<number | "">(props.initialRootId ?? props.roots[0]?.id ?? "");
  const [path, setPath] = useState(props.roots.find((r) => r.id === (props.initialRootId ?? props.roots[0]?.id))?.path ?? "");
  const [mode, setMode] = useState<"preview" | "direct">("preview");
  const [deep, setDeep] = useState(true);
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [includeMissing, setIncludeMissing] = useState(false);
  const previewRequest = useRef(0);
  const listRequest = useRef(0);

  const openPreview = useCallback((id: number) => {
    const requestId = ++previewRequest.current;
    setOpeningId(id);
    setErr("");
    return Promise.all([getScanPreview(id), listScanPreviewItems(id, { limit: 100, change: filter || undefined })])
      .then(([d, page]) => {
        if (requestId !== previewRequest.current) return;
        setSel(d.preview); setItems(page.items); setCursor(page.nextCursor);
      })
      .catch((e) => { if (requestId === previewRequest.current) setErr(describeError(e)); })
      .finally(() => { if (requestId === previewRequest.current) setOpeningId(null); });
  }, [filter]);

  const loadList = useCallback((selectId?: number) => {
    const requestId = ++listRequest.current;
    const selectedRequest = previewRequest.current;
    setLoading(true); setErr("");
    return listScanPreviews(40)
      .then(async (r) => {
        if (requestId !== listRequest.current) return;
        setList(r.previews);
        const want = selectId ?? sel?.id ?? r.previews[0]?.id;
        const p = r.previews.find((x) => x.id === want) ?? r.previews[0] ?? null;
        if (p && previewRequest.current === selectedRequest) await openPreview(p.id);
      })
      .catch((e) => { if (requestId === listRequest.current) { setErr(describeError(e)); setList([]); } })
      .finally(() => { if (requestId === listRequest.current) setLoading(false); });
  }, [openPreview, sel?.id]);

  useEffect(() => { void loadList(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  /** 扫描中 / 应用中：轮询详情；状态落定后刷新条目与列表。 */
  const selectedId = sel?.id;
  const selectedState = sel?.state;
  const { onChanged } = props;
  useEffect(() => {
    if (selectedId === undefined || (selectedState !== "scanning" && selectedState !== "applying") || openingId !== null) return;
    const selectedRequest = previewRequest.current;
    let active = true;
    let pending = false;
    const t = setInterval(() => {
      if (pending) return;
      pending = true;
      getScanPreview(selectedId).then((d) => {
        if (!active || previewRequest.current !== selectedRequest || d.preview.id !== selectedId) return;
        setSel(d.preview);
        if (!["scanning", "applying"].includes(d.preview.state)) {
          void loadList(d.preview.id);
          if (selectedState === "applying") onChanged();
        }
      }).catch(() => { /* 下次轮询重试 */ }).finally(() => { pending = false; });
    }, 1500);
    return () => { active = false; clearInterval(t); };
  }, [selectedId, selectedState, openingId, loadList, onChanged]);

  const run = (label: string, fn: () => Promise<void>) => {
    if (busy || openingId !== null) return;
    setBusy(label);
    fn().catch((e) => props.onToast("bad", label + "失败：" + describeError(e))).finally(() => setBusy(""));
  };

  const doCreate = () => run(mode === "direct" ? "扫描" : "生成预览", async () => {
    if (!path.trim()) { props.onToast("bad", "请先选择扫描路径。"); return; }
    if (mode === "direct") {
      if (!window.confirm("即将直接扫描并记录：" + path + "\n此操作会立即更新库中文件记录。继续吗？")) return;
      const job = await scan({ ...(rootId === "" ? {} : { rootId: Number(rootId) }), path: path.trim(), deep });
      props.onToast("ok", "扫描任务 #" + job.jobId + " 已排队，请在任务列表查看进度。");
      props.onJobsChanged?.();
      return;
    }
    const r = await createScanPreview({ ...(rootId === "" ? {} : { rootId: Number(rootId) }), path: path.trim(), deep });
    props.onJobsChanged?.();
    props.onToast("ok", r.existing ? "已打开相同扫描范围的预览。" : "扫描预览已开始。");
    await loadList(r.previewId);
  });

  const doDecide = (item: ScanPreviewItem, accept: boolean) => run("勾选", async () => {
    const r = await decideScanPreviewItems(sel!.id, { keys: [item.item_key], decision: accept ? "accept" : "skip" });
    setSel((s) => s ? { ...s, itemCounts: r.itemCounts } : s);
    setItems((xs) => xs.map((x) => (x.id === item.id ? { ...x, decision: accept ? "accept" : "skip" } : x)));
  });

  const doAcceptAll = () => run("勾选变化项", async () => {
    const selectedTypes = ["new", "changed", ...(includeDuplicates ? ["duplicate_suspected"] : []), ...(includeMissing ? ["missing"] : [])];
    const r = await decideScanPreviewItems(sel!.id, { change: selectedTypes.join(","), decision: "accept" });
    props.onToast(r.itemCounts.accepted ? "ok" : "info", "待应用 " + r.itemCounts.accepted + " 项");
    await openPreview(sel!.id);
  });

  const doApply = () => run("应用", async () => {
    const p = sel!;
    const breakdown = APPLICABLE.map((change) => [CHANGE_LABEL[change], p.itemCounts.byChange?.[change] ?? 0] as const)
      .filter(([, count]) => count > 0).map(([label, count]) => label + " " + count).join(" · ");
    if (!window.confirm("将应用 " + p.itemCounts.accepted + " 项已选变化。\n" + breakdown + "\n继续？")) return;
    const r = await applyScanPreview(p.id, { planHash: p.plan_hash ?? undefined, selectionToken: p.itemCounts.selectionToken });
    props.onJobsChanged?.();
    props.onToast("ok", "已提交应用：文件 " + r.files + " 条 / 缺失 " + r.missing + " 条 / 过期跳过 " + r.stale + " 条");
    await loadList(p.id);
  });

  const doCancel = () => run("取消", async () => {
    await cancelScanPreview(sel!.id);
    props.onToast("info", "预览已取消（保留已生成的结果）");
    await loadList(sel!.id);
  });

  const doRetry = () => run("重试", async () => {
    const r = await retryScanPreview(sel!.id);
    props.onJobsChanged?.();
    props.onToast("ok", "已重试失败的 " + r.retried + " 条（文件 " + r.files + " / 缺失 " + r.missing + " / 过期 " + r.stale + "）");
    await loadList(sel!.id);
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
  const mayEdit = !busy && openingId === null && !!sel && ["ready", "partial"].includes(sel.state);

  return (
    <div className="backdrop" onClick={props.onClose}>
        <div className="drawer" role="dialog" aria-label="扫描库" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>扫描库</h3>
          <span className="spacer" />
          {(busy || loading || openingId !== null) && <Spinner />}
          <button className="btn" onClick={props.onClose}>关闭</button>
        </div>

        <div className="preview-body">
          <div className="left">
            <div className="section">
              <div className="seg" style={{ marginBottom: "6px" }}>
                <button className={mode === "preview" ? "on" : ""} onClick={() => setMode("preview")}>预览后应用</button>
                <button className={mode === "direct" ? "on" : ""} onClick={() => setMode("direct")}>直接扫描</button>
              </div>
              <select value={rootId} onChange={(e) => { const id = e.target.value === "" ? "" : Number(e.target.value); setRootId(id); const row = props.roots.find((r) => r.id === id); if (row) setPath(row.path); }} style={{ width: "100%" }}>
                <option value="">选择扫描根目录</option>
                {props.roots.map((r) => <option key={r.id} value={r.id}>#{r.id} {shortenPath(r.path, 34)}</option>)}
              </select>
              <input type="text" aria-label="扫描路径" value={path} onChange={(e) => { const value = e.target.value; setPath(value); if (!props.roots.some((r) => r.id === rootId && r.path === value)) setRootId(""); }} placeholder="扫描路径" style={{ marginTop: "6px" }} />
              <label className="row" style={{ marginTop: "6px", gap: "5px", cursor: "pointer" }}>
                <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} /> 深度扫描（最多 10 层）
              </label>
              <button className="btn primary" style={{ marginTop: "8px", width: "100%" }} disabled={!!busy || openingId !== null || !path.trim()} onClick={doCreate}>{mode === "preview" ? "生成预览" : "开始扫描"}</button>
              <div className="hint" style={{ marginTop: "6px" }}>{mode === "preview" ? "预览只保存待审核清单；确认后再选择要应用的变化。" : "直接扫描会立即更新文件记录；可在任务列表查看进度。"}</div>
            </div>

            <div className="row" style={{ gap: "6px" }}>
              <span className="hint">最近预览</span>
              <span className="spacer" />
              <button className="btn tiny" onClick={() => void loadList()} disabled={!!busy || !!loading || openingId !== null}>刷新</button>
            </div>
            {list.map((p) => (
              <button key={p.id} className={"preview-row" + (sel?.id === p.id ? " on" : "")} onClick={() => void openPreview(p.id)} disabled={!!busy || openingId !== null} title={p.path}>
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
            {err && <div className="notice bad">无法读取扫描预览：{err}</div>}
            {!sel && !err && <div className="empty">左侧选择一个预览查看详情</div>}
            {sel && (
              <>
                <div className="row wrap" style={{ gap: "6px" }}>
                  <b>{"扫描预览"} #{sel.id}</b>
                  <Badge tone={STATE_TONE[sel.state] ?? "muted"}>{STATE_LABEL[sel.state] ?? sel.state}</Badge>
                  {sel.truncated && <Badge tone="warn">扫描已截断</Badge>}
                  {!sel.complete && sel.state === "partial" && <Badge tone="warn">扫描不完整，未判定缺失</Badge>}
                  <span className="spacer" />
                  <span className="hint">{"文件"} {sel.files} · {"文件夹"} {sel.dirs} · {formatBytes(sel.bytes)} · {"错误"} {sel.error_count}</span>
                </div>
                <div className="hint mono" style={{ wordBreak: "break-all" }}>{sel.path}（{sel.deep ? "深度 10" : "深度 6"}）</div>
                {sel.error && <div className="notice bad">{sel.error}</div>}
                {sel.scan && sel.scan.missingProposed === false && (
                  <div className="notice">本轮扫描不完整（{sel.scan.reasons?.join(" / ") || "存在读取错误"}）：**不提出缺失项**，请修好可读性后重新扫描。</div>
                )}

                <div className="row wrap" style={{ gap: "6px" }}>
                  <button className={"cat-chip" + (filter === "changes" ? " on" : "")} onClick={() => void changeFilter("changes")}>{"变化"} {(counts?.new ?? 0) + (counts?.changed ?? 0)}</button>
                  <button className={"cat-chip" + (filter === "" ? " on" : "")} onClick={() => void changeFilter("")}>{"全部"} {counts?.total ?? 0}</button>
                  {(Object.keys(CHANGE_LABEL) as string[]).map((c) => (
                    <button key={c} className={"cat-chip" + (filter === c ? " on" : "")} onClick={() => void changeFilter(c)}>{CHANGE_LABEL[c]} {counts ? (counts as any)[c] ?? 0 : 0}</button>
                  ))}
                </div>

                <div className="row wrap" style={{ gap: "6px" }}>
                  <span className="hint">待应用 {sel.itemCounts.accepted} · 已应用 {sel.itemCounts.applied} · 失败 {sel.itemCounts.failed ?? 0}</span>
                  <span className="spacer" />
                  <label className="chk"><input type="checkbox" checked={includeDuplicates} disabled={!mayEdit} onChange={(e) => setIncludeDuplicates(e.target.checked)} /> 包含疑似重复 ({counts?.duplicate_suspected ?? 0})</label>
                  <label className="chk"><input type="checkbox" checked={includeMissing} disabled={!mayEdit} onChange={(e) => setIncludeMissing(e.target.checked)} /> 包含缺失 ({counts?.missing ?? 0})</label>
                  <button className="btn tiny" disabled={!mayEdit} onClick={doAcceptAll}>勾选变化项</button>
                  <button className="btn tiny primary" disabled={!mayEdit || sel.itemCounts.accepted === 0} onClick={doApply}>应用已选 ({sel.itemCounts.accepted})</button>
                  <button className="btn tiny" disabled={!!busy || openingId !== null || !["ready", "partial", "partially_applied", "failed"].includes(sel.state) || !sel.itemCounts.failed} onClick={doRetry}>重试失败项</button>
                  <button className="btn tiny" disabled={!!busy || openingId !== null || !["ready", "partial", "scanning"].includes(sel.state)} onClick={doCancel}>取消预览</button>
                  <button className="btn tiny" disabled={!!busy || openingId !== null || sel.state === "applying"} onClick={doDelete}>删除预览</button>
                </div>

                <div className="preview-list">
                  {items.map((it) => (
                    <div className="preview-item" key={it.id}>
                      <input type="checkbox" aria-label={CHANGE_LABEL[it.change] + " " + it.path} disabled={!mayEdit || it.applied === 1 || !APPLICABLE.includes(it.change as any)
                        || (it.decision !== "accept" && ((it.change === "duplicate_suspected" && !includeDuplicates) || (it.change === "missing" && !includeMissing)))}
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
