import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { createPortal } from "react-dom";
import type { BoothItemMeta } from "@core/contracts";
import {
  addAssetWithExpected, boothPeek, commitStage, describeError, importAcceptedFiles, importUrl, listItems,
  precheckPaths, stageDownload, type StageDownloadResponse,
} from "../api";
import type { BoothPeekResponse, LibraryRootRow, PrecheckResponse, PrecheckResult, ViewMode } from "../types";
import {
  acceptedFileOf, expectedOf, pathCollisionText, summaryLabel, summaryPriority, versionCandidateText, warningText,
} from "../precheck-view";
import { looksLikeBoothUrl } from "../util";
import {
  createGateLifecycle, createPrecheckGate, mergePathDraft, pathsFromFileList, pickNextBatch, runGuarded,
  shouldAcceptExternalBatch, splitDraftPaths, type ExternalBatch,
} from "../file-intake";
import { Badge, Section, Spinner } from "./ui";

/** toast 里展示非法草稿行：截断，避免长行撑爆提示。 */
function shortText(s: string, n = 40): string {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) + "…" : t;
}

const LAST_DESTINATION = "av.localImportDestination";
function lastDestination(): string {
  try { return localStorage.getItem(LAST_DESTINATION) ?? ""; } catch { return ""; }
}

export function ImportPanel(props: {
  roots: LibraryRootRow[];
  onToast: (kind: "ok" | "bad" | "info", text: string) => void;
  onJobsChanged: () => void;
  onDataChanged: () => void;
  onOpenScan: () => void;
  mode: ViewMode;
  /** 路径冲突行的「去合并条目…」：打开既有条目（合并入口在 ItemDetail）。未传时按钮禁用并说明。 */
  onOpenItem?: (itemId: number) => void;
  /** 全局拖入/粘贴收集到的批次（App 级 GlobalDrop 注入，带单调 id）；消费后按 id 回调。 */
  externalBatches?: ExternalBatch[];
  onExternalPathsConsumed?: (id: number) => void;
}) {
  const [url, setUrl] = useState("");
  const [peek, setPeek] = useState<BoothPeekResponse | null>(null);
  const [peeking, setPeeking] = useState(false);
  const [paths, setPaths] = useState("");
  // 同步镜像：外部批次注入时要读「最新草稿」，不能读渲染闭包里的旧值。
  const pathsRef = useRef("");
  const updatePaths = (fn: (prev: string) => string) => {
    setPaths((prev) => { const next = fn(prev); pathsRef.current = next; return next; });
  };
  const [hot, setHot] = useState(false);
  const [busy, setBusy] = useState("");
  // 预检卡：逐行选择（默认勾选有 expected 且无路径冲突的行），跳过只影响本次提交。
  const [precheck, setPrecheck] = useState<PrecheckResponse | null>(null);
  const [prechecking, setPrechecking] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const [importing, setImporting] = useState(false);
  const [dropDialog, setDropDialog] = useState(false);
  const [destinationMode, setDestinationMode] = useState<"in-place" | "copy">("in-place");
  const [destination, setDestination] = useState("");
  const [boothLink, setBoothLink] = useState("");
  const [dropError, setDropError] = useState("");
  const dropRequest = useRef(0);
  // 下载：固定 stage=true，完成后只展示预检卡，由用户 import/skip 才 commit。
  const [dlUrl, setDlUrl] = useState("");
  const [dlItemId, setDlItemId] = useState("");
  const [dlBusy, setDlBusy] = useState(false);
  const [staged, setStaged] = useState<StageDownloadResponse | null>(null);
  const [committing, setCommitting] = useState(false);
  const dlCtl = useRef<AbortController | null>(null);
  // N2（Ruling19）：预检行 → 用户显式选既有条目 → 带 expected 的安全同步登记 → 真实 assetId。
  // 不自动推断目标、不先走 unsafe addAsset、不提交原目录；版本关系由用户在条目详情里人工建立。
  const [assoc, setAssoc] = useState<{
    key: string; q: string; hits: { id: number; title: string }[]; itemId: number | null;
    busy: boolean; err: string; done: { itemId: number; assetIds: number[] } | null;
  } | null>(null);

  const fileRef = useRef<HTMLInputElement | null>(null);

  const doPeek = () => {
    const u = url.trim();
    if (!u) return;
    setPeeking(true); setPeek(null);
    boothPeek(u)
      .then((p) => setPeek(p))
      .catch((e) => props.onToast("bad", describeError(e)))
      .finally(() => setPeeking(false));
  };

  const doImportUrl = () => {
    const u = url.trim();
    if (!u) return;
    setBusy("url");
    importUrl(u, true)
      .then((r) => { props.onToast("ok", "已起 import_url 作业 #" + r.jobId + (r.itemId ? "（item #" + r.itemId + "）" : "")); props.onJobsChanged(); props.onDataChanged(); })
      .catch((e) => props.onToast("bad", describeError(e)))
      .finally(() => setBusy(""));
  };

  // 预检在飞控制（F3）：begin 同步挡同 tick 第二批；cancel 是真实可达的失效点（取消后迟到响应不回写）。
  // HB1：每次挂载用 createGateLifecycle 建一个**本次专属** gate，cleanup 只 dispose 自己捕获的那个——
  // StrictMode 的 setup→cleanup→setup 因此不会把第二次 setup 的新 gate 一起废掉（dev 下预检不再永久死）。
  const gateRef = useRef(createPrecheckGate());
  useEffect(() => {
    const life = createGateLifecycle();
    gateRef.current = life.gate;
    return () => { life.dispose(); };
  }, []);

  /**
   * 预检（H1）：草稿原样保留，但**只把严格绝对路径**送 API。
   * 环境变量占位（%VAR%）、相对路径、普通文字、畸形 URI 留在草稿里，并给出准确反馈（不假称已预检）。
   */
  const doPrecheck = (draftOverride?: string, fromDrop = false) => {
    const draft = draftOverride ?? pathsRef.current;
    const { valid, invalid } = splitDraftPaths(draft);
    if (!valid.length) {
      props.onToast("bad", invalid.length
        ? "草稿里没有可预检的绝对路径（" + invalid.length + " 行不是绝对路径，例如：" + shortText(invalid[0]) + "）"
        : "没有可预检的路径");
      return;
    }
    if (gateRef.current.isBusy()) { props.onToast("info", "正在预检，稍后再试"); return; }
    const skippedNote = invalid.length ? "（已跳过 " + invalid.length + " 行非绝对路径，草稿保留）" : "";
    setPrechecking(true); setPrecheck(null); setSelected({}); setSkipped({});
    setDropDialog(fromDrop);
    if (fromDrop) {
      dropRequest.current++;
      const previous = lastDestination();
      setDestination(previous);
      setDestinationMode(previous ? "copy" : "in-place");
      setBoothLink("");
      setDropError("");
    }
    const gen = runGuarded(gateRef.current, () => precheckPaths({ paths: valid }), {
      onValue: (r) => {
        setPrecheck(r);
        // 默认只勾选「有 expected、无路径冲突、且不是精确重复」的行：
        // exact 已确认在库里，不默认再登记一次（要导入必须用户自己勾）。
        const init: Record<string, boolean> = {};
        for (const row of r.results) {
          init[row.pathNorm] = expectedOf(row) !== null && row.match.pathCollision === null && row.summary !== "exact";
        }
        setSelected(init);
        if (!fromDrop) props.onToast("ok", "预检完成：" + r.results.length + " 个文件" + (r.budget.truncated ? "（预算不足，已截断）" : "") + skippedNote);
      },
      onError: (e) => fromDrop ? setDropError(describeError(e)) : props.onToast("bad", describeError(e)),
      onSettled: () => setPrechecking(false),
    });
    if (gen === null) { setPrechecking(false); props.onToast("info", "正在预检，稍后再试"); }
  };

  /** 取消当前预检（含待确认卡）：使在飞响应失效，并清掉勾选/跳过，让新批次可接收。 */
  const cancelPrecheck = () => {
    gateRef.current.cancel();
    dropRequest.current++;
    setDropDialog(false);
    setPrechecking(false);
    setPrecheck(null);
    setSelected({});
    setSkipped({});
    props.onToast("info", "已取消当前预检（草稿保留）");
  };

  const toggleRow = (key: string) => setSelected((s) => ({ ...s, [key]: !s[key] }));

  const skipRow = (row: PrecheckResult) => {
    setSelected((s) => ({ ...s, [row.pathNorm]: false }));
    setSkipped((s) => ({ ...s, [row.pathNorm]: true }));
    props.onToast("info", "已跳过：" + row.path + "（文件已保留，未登记）");
  };

  /** 只提交当前勾选的文件（每项带 expected）；缺 expected 的行不伪造字段、不提交。 */
  const doImportSelected = () => {
    if (!precheck || importing) return;
    const files = precheck.results
      .filter((r) => selected[r.pathNorm])
      .map((r) => acceptedFileOf(r))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (!files.length) { props.onToast("bad", "没有可导入的文件（缺 expected 元数据的行不能导入）"); return; }
    const target = dropDialog && destinationMode === "copy" ? destination.trim() : "";
    if (dropDialog && destinationMode === "copy" && !target) return;
    setDropError("");
    setImporting(true);
    importAcceptedFiles(files, dropDialog ? { destination: target || undefined, boothUrl: boothLink.trim() || undefined } : undefined)
      .then((r) => {
        if (r.jobIds.length === 0) {
          // 后端还没接 files 形状时会静默返回 0 个作业：明确报出来，不假装已导入。
          const message = "没有创建导入作业，请检查文件后重试。";
          if (dropDialog) setDropError(message); else props.onToast("bad", message);
          return;
        }
        if (dropDialog) {
          try { localStorage.setItem(LAST_DESTINATION, target); } catch { /* storage is optional */ }
          setDropDialog(false);
        }
        props.onToast("ok", "已起 " + r.jobIds.length + " 个 import_file 作业" + (r.duplicates.length ? "（重复路径 " + r.duplicates.length + " 条已去重）" : ""));
        props.onJobsChanged(); props.onDataChanged();
        setPrecheck(null); setSelected({}); setSkipped({});
      })
      .catch((e) => dropDialog ? setDropError(describeError(e)) : props.onToast("bad", describeError(e)))
      .finally(() => setImporting(false));
  };

  const doStageDownload = () => {
    const u = dlUrl.trim();
    if (!u) return;
    const ctl = new AbortController();
    dlCtl.current = ctl;
    setDlBusy(true); setStaged(null);
    stageDownload({ url: u, itemId: dlItemId.trim() || null }, { signal: ctl.signal })
      .then((r) => {
        setStaged(r);
        props.onToast("ok", "已下载并预检：" + r.fileName + "（" + r.bytes + " B），请选择导入或跳过");
      })
      .catch((e) => {
        if (ctl.signal.aborted) props.onToast("info", "已取消下载（临时文件由服务端清理，未登记）");
        else props.onToast("bad", describeError(e));
      })
      .finally(() => { setDlBusy(false); dlCtl.current = null; });
  };

  const cancelDownload = () => { dlCtl.current?.abort(); };

  const doCommit = (decision: "import" | "skip") => {
    if (!staged) return;
    setCommitting(true);
    commitStage(staged.stageToken, decision)
      .then((r) => {
        if (r.decision === "skip") props.onToast("info", "文件已保留在下载目录，未登记");
        else props.onToast("ok", "已登记 item #" + (r.itemId ?? "?") + " asset #" + (r.assetId ?? "?") + (r.replayed ? "（重放）" : ""));
        setStaged(null);
        if (r.decision === "import") props.onDataChanged();
      })
      .catch((e) => props.onToast("bad", describeError(e)))
      .finally(() => setCommitting(false));
  };

  /** 候选条目：留空列最近 6 条（不依赖 FTS 索引），≥2 字按关键词搜；都只是候选，选中仍由用户点。 */
  const loadAssocHits = (q: string) => {
    const t = q.trim();
    listItems(t.length >= 2 ? { q: t, limit: 6 } : { limit: 6 })
      .then((r) => setAssoc((s) => (s && s.q === q ? { ...s, hits: r.items.map((x) => ({ id: x.id, title: x.title })) } : s)))
      .catch(() => setAssoc((s) => (s ? { ...s, hits: [] } : s)));
  };

  const openAssoc = (key: string) => {
    setAssoc({ key, q: "", hits: [], itemId: null, busy: false, err: "", done: null });
    loadAssocHits("");
  };

  /** 目标条目只由用户搜索并显式选择；不按同商品/路径冲突自动填。 */
  const searchAssoc = (q: string) => {
    setAssoc((s) => (s ? { ...s, q, itemId: null, done: null, err: "" } : s));
    loadAssocHits(q);
  };

  /** 唯一关联写入口：单个文件 + 该行真实 expected；服务端重验 + owner 门后才登记。 */
  const doAssociate = (row: PrecheckResult) => {
    if (!assoc || assoc.itemId === null) return;
    const exp = expectedOf(row);
    if (!exp) { setAssoc((s) => (s ? { ...s, err: "该行缺 expected 元数据，不能安全登记" } : s)); return; }
    const target = assoc.itemId;
    setAssoc((s) => (s ? { ...s, busy: true, err: "" } : s));
    addAssetWithExpected(target, row.path, exp)
      .then((r) => {
        setAssoc((s) => (s ? { ...s, busy: false, done: { itemId: target, assetIds: r.assetIds } } : s));
        props.onToast("ok", "已安全登记到条目 #" + target + "（新增 " + r.added + " 个资产）");
        props.onDataChanged();
      })
      .catch((e) => setAssoc((s) => (s ? { ...s, busy: false, err: describeError(e) } : s)));
  };

  /**
   * 文件选择：桥优先（Electron 38 的 File.path 已移除），回退旧 File.path，都无则如实提示。
   * M2：与全局入口同一同步忙碌门——待确认/预检/导入时不改草稿、不换卡，只给准确反馈。
   */
  const handleFiles = (files: FileList | null) => {
    if (!files || !files.length) return;
    if (!shouldAcceptExternalBatch({ prechecking: gateRef.current.isBusy(), importing, pending: precheck !== null || dropDialog })) {
      props.onToast("info", "正在预检/提交或有待确认的预检，已忽略本次选择（不覆盖当前批次）");
      return;
    }
    const r = pathsFromFileList(files, {
      getPathForFile: (f) => (typeof window === "undefined" ? null : window.assetVaultDesktop?.getPathForFile(f) ?? null),
    });
    if (r.paths.length) {
      updatePaths((p) => mergePathDraft(p, r.paths));
      doPrecheck(r.paths.join("\n"), true);
    } else {
      props.onToast("info", "浏览器不暴露本地绝对路径，已忽略 " + r.ignored + " 个文件（请改用粘贴路径）");
    }
  };

  /**
   * N3：面板的 drop 只做**防导航窄 guard**——外部 Files 拖到面板时阻止浏览器默认动作
   * （无桥/虚拟 File 时否则会导航到该文件）。不读路径、不触预检：唯一入口仍是 App 级 GlobalDrop。
   * 不 stopPropagation，事件照常冒泡到 window。
   */
  const onDrop = (e: ReactDragEvent) => {
    if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
  };

  // 全局拖入/粘贴批次（N2）：身份是单调 id，不是路径内容。
  // - 同一 id 只消费一次（StrictMode 双跑/同事件重放不重复消费）；
  // - 同内容的新 id 仍会被处理（A→取消→再次 A 第一遍就进）；
  // - 队列里更晚的批次不会被清空回调抹掉（App 按 id CAS 移除）。
  // 预检中/提交中/已有待确认卡都明确拒绝（不覆盖、不改草稿）。
  const consumedRef = useRef<number>(0);
  useEffect(() => {
    const next = pickNextBatch(props.externalBatches ?? [], consumedRef.current);
    if (!next) return;
    consumedRef.current = next.id;
    if (!shouldAcceptExternalBatch({ prechecking: gateRef.current.isBusy(), importing, pending: precheck !== null || dropDialog })) {
      props.onToast("info", "正在预检/提交或有待确认的预检，已忽略本次拖入（不覆盖当前批次）");
      props.onExternalPathsConsumed?.(next.id);
      return;
    }
    const merged = mergePathDraft(pathsRef.current, next.paths);
    updatePaths(() => merged);
    props.onExternalPathsConsumed?.(next.id);
    doPrecheck(next.paths.join("\n"), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.externalBatches]);

  const meta: BoothItemMeta | null = peek;
  const precheckRows = precheck
    ? precheck.results.slice().sort((a, b) => summaryPriority(b.summary) - summaryPriority(a.summary))
    : [];
  const selectedCount = precheck ? precheck.results.filter((r) => selected[r.pathNorm]).length : 0;
  const sizeText = (r: PrecheckResult): string => (typeof r.size === "number" && Number.isFinite(r.size) ? r.size + " B" : "大小未知");
  const mtimeText = (r: PrecheckResult): string => (typeof r.mtime === "string" && r.mtime ? r.mtime : "mtime 未知");
  const chooseFolder = typeof window === "undefined" ? undefined : window.assetVaultDesktop?.chooseImportFolder;

  return (
    <div className="col-scroll">
      <div className="pane-body" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <Section title={<>导入 BOOTH 链接 {props.mode === "mock" && <Badge tone="warn">mock</Badge>}</>}>
          <div className="row">
            <input type="url" placeholder="https://booth.pm/ja/items/6115428" value={url} onChange={(e) => setUrl(e.target.value)} />
            <button className="btn" disabled={!url.trim() || peeking} onClick={doPeek}>{peeking ? "…" : "预览"}</button>
          </div>
          {url.trim() && !looksLikeBoothUrl(url) && <div className="hint" style={{ color: "var(--warn)" }}>看起来不是 booth.pm 链接，仍会交给后端解析。</div>}
          {meta && (
            <div className="peek" style={{ marginTop: "8px" }}>
              <img src={meta.images[0]?.resized ?? meta.images[0]?.original ?? ""} alt="" />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="t">{meta.title}</div>
                <div className="row wrap" style={{ marginTop: "4px" }}>
                  <Badge>{meta.priceText ?? "—"}</Badge>
                  {meta.isAdult && <Badge tone="bad">R18</Badge>}
                  <Badge tone="muted">{meta.shop?.name ?? "—"}</Badge>
                  <Badge tone="muted">{meta.category?.name ?? "—"}</Badge>
                  <Badge tone="muted">{meta.images.length} 图</Badge>
                </div>
                <div className="row wrap" style={{ marginTop: "4px" }}>
                  {meta.tags.slice(0, 8).map((t) => <Badge key={t.name} tone="violet">{t.name}</Badge>)}
                </div>
                {meta.variations[0]?.files[0] && <div className="hint" style={{ marginTop: "4px" }}>文件：{meta.variations[0].files[0].name}（{meta.variations[0].files[0].file_size ?? "?"}）</div>}
                <div className="row" style={{ marginTop: "6px" }}>
                  {peek?.inLibrary && <Badge tone="warn">库中已有 item #{peek.inLibrary.itemId}</Badge>}
                  <span className="spacer" />
                  <button className="btn primary" disabled={busy === "url"} onClick={doImportUrl}>{busy === "url" ? <Spinner /> : "导入"}</button>
                </div>
              </div>
            </div>
          )}
          {!meta && <div className="hint" style={{ marginTop: "6px" }}>GET /booth/peek?url= — 只读预览，不落库。</div>}
        </Section>

        <Section title="下载（两阶段：预检后确认）">
          <div className="row">
            <input type="url" placeholder="https://booth.pm/downloadables/…" value={dlUrl} onChange={(e) => setDlUrl(e.target.value)} />
            <input type="text" placeholder="商品号（可选）" value={dlItemId} onChange={(e) => setDlItemId(e.target.value)} style={{ width: "110px" }} />
            <button className="btn" disabled={!dlUrl.trim() || dlBusy} onClick={doStageDownload}>{dlBusy ? <Spinner /> : "下载并预检"}</button>
            {dlBusy && <button className="btn danger" onClick={cancelDownload}>取消</button>}
          </div>
          <div className="hint" style={{ marginTop: "4px" }}>固定 stage=true：下载后只做只读预检（不建 item/asset/job），确认后才登记；跳过时文件保留、不自动删除。</div>
          {staged && (
            <div style={{ marginTop: "8px" }}>
              <div className="row wrap">
                <Badge tone="busy">已暂存</Badge>
                <span className="mono" style={{ fontSize: "11px", wordBreak: "break-all" }}>{staged.fileName}</span>
                <span className="hint">{staged.bytes} B</span>
                <span className="spacer" />
                <button className="btn primary" disabled={committing} onClick={() => doCommit("import")}>{committing ? <Spinner /> : "导入"}</button>
                <button className="btn" disabled={committing} onClick={() => doCommit("skip")}>跳过</button>
              </div>
              <div className="hint" style={{ marginTop: "3px" }}>
                {staged.meta ? "元数据：" + staged.meta.title : "元数据未取到，不影响文件与预检"}
              </div>
              {staged.precheck.results.map((row) => (
                <div key={row.pathNorm} className="hint" style={{ marginTop: "2px", wordBreak: "break-all" }}>
                  <Badge tone={row.summary === "exact" ? "bad" : row.summary === "unknown" ? "muted" : "warn"}>{summaryLabel(row.summary)}</Badge>{" "}
                  {row.path} · {sizeText(row)} · {mtimeText(row)}
                  {row.match.pathCollision ? " · " + pathCollisionText(row.match.pathCollision) : ""}
                  {warningText(row) ? " · " + warningText(row) : ""}
                </div>
              ))}
            </div>
          )}
        </Section>

        <button className="btn" onClick={props.onOpenScan}>扫描库…</button>

        <Section title="本地路径导入">
          <textarea rows={4} placeholder={"C:\\Downloads\\pkg.zip\n/home/u/素材库/abc 目录"} value={paths} onChange={(e) => updatePaths(() => e.target.value)} />
          <div className="hint" style={{ marginTop: "3px" }}>只接受绝对路径；%变量%、相对路径与普通文字会留在草稿里但不送预检。</div>
          <div className="row" style={{ marginTop: "6px" }}>
            <input ref={fileRef} type="file" multiple style={{ display: "none" }} onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
            <button className="btn tiny" onClick={() => fileRef.current?.click()}>选择文件</button>
            <span className="spacer" />
          </div>
        </Section>

        <Section title="导入预检（只读）">
          <div className="row">
            <span className="hint">对上方「本地路径导入」里的路径做只读预检：不写库、不建 job。</span>
            <span className="spacer" />
            <button className="btn" disabled={prechecking || splitDraftPaths(paths).valid.length === 0} onClick={() => doPrecheck()}>{prechecking ? <Spinner /> : "预检"}</button>
            {!dropDialog && (precheck || prechecking) && (
              <button className="btn tiny ghost" onClick={cancelPrecheck} title="取消当前预检（含待确认卡），草稿保留">
                取消预检
              </button>
            )}
          </div>
          {precheck && !dropDialog && (
            <div style={{ marginTop: "8px" }}>
              <div className="hint">
                预检于 {precheck.checkedAt} · {precheck.results.length} 个文件
                {precheck.budget.truncated ? " · 预算不足已截断：未展示的文件不会被登记，需要时请重新预检" : ""}
              </div>
              {precheckRows.map((row) => {
                const key = row.pathNorm;
                const exp = expectedOf(row);
                const isSkipped = skipped[key] === true;
                const collision = row.match.pathCollision;
                return (
                  <div key={key} style={{ borderTop: "1px solid var(--line-soft)", padding: "6px 0" }}>
                    <div className="row wrap" style={{ gap: "6px" }}>
                      <input
                        type="checkbox"
                        checked={selected[key] === true}
                        disabled={!exp || isSkipped}
                        onChange={() => toggleRow(key)}
                        title={exp ? "勾选后才会提交（带 expected）" : "缺 expected 元数据，不能导入"}
                      />
                      <Badge tone={row.summary === "exact" ? "bad" : row.summary === "unknown" ? "muted" : "warn"}>{summaryLabel(row.summary)}</Badge>
                      <span className="mono" style={{ fontSize: "11px", wordBreak: "break-all" }}>{row.path}</span>
                      <span className="spacer" />
                      <span className="hint">{sizeText(row)} · {mtimeText(row)}</span>
                    </div>
                    <div className="hint" style={{ marginTop: "2px" }}>
                      {row.hash.state === "ok" ? "哈希已算" : "哈希未知（" + (row.hash.reason ?? "未给原因") + "）"}
                      {row.match.exact ? " · 已有资产 #" + row.match.exact.assetId + "（item #" + row.match.exact.itemId + "）" : ""}
                      {row.match.sameProduct ? " · 同商品 item #" + row.match.sameProduct.itemId + "《" + row.match.sameProduct.title + "》" : ""}
                      {row.match.companion ? " · 配套标记：" + row.match.companion.markers.join("、") : ""}
                    </div>
                    {row.match.version && <div className="hint">{versionCandidateText(row.match.version)}</div>}
                    {collision && <div className="hint" style={{ color: "var(--warn)" }}>{pathCollisionText(collision)}</div>}
                    {warningText(row) && <div className="hint" style={{ color: "var(--warn)" }}>{warningText(row)}</div>}
                    <div className="row wrap" style={{ marginTop: "3px" }}>
                      <button className="btn tiny" onClick={() => skipRow(row)}>跳过（不登记）</button>
                      <button className="btn tiny" disabled={!exp || isSkipped} onClick={() => setSelected((s) => ({ ...s, [key]: true }))}>仍然导入</button>
                      {collision && (
                        <button
                          className="btn tiny"
                          disabled={!props.onOpenItem}
                          title={props.onOpenItem ? "打开该条目（既有合并入口）" : "需要父级传入 onOpenItem（P1-T5 挂载）"}
                          onClick={() => props.onOpenItem?.(collision.itemId)}
                        >去合并条目…</button>
                      )}
                      {isSkipped && <span className="hint">已跳过：文件已保留，未登记</span>}
                    </div>
                    {exp && (
                      <div style={{ marginTop: "3px" }}>
                        <button className="btn tiny" onClick={() => openAssoc(key)}>关联到既有条目…</button>
                        {assoc?.key === key && (
                          <div className="row wrap" style={{ gap: "6px", marginTop: "3px" }}>
                            <input
                              placeholder="搜索目标条目（留空=最近条目）"
                              value={assoc.q}
                              onChange={(e) => searchAssoc(e.target.value)}
                              style={{ minWidth: "180px" }}
                            />
                            <select
                              value={assoc.itemId ?? ""}
                              onChange={(e) => setAssoc((s) => (s ? { ...s, itemId: e.target.value === "" ? null : Number(e.target.value), done: null } : s))}
                            >
                              <option value="">选择条目…</option>
                              {assoc.hits.map((h) => <option key={h.id} value={h.id}>#{h.id} {h.title}</option>)}
                            </select>
                            <button className="btn tiny" disabled={assoc.itemId === null || assoc.busy} onClick={() => doAssociate(row)}>
                              {assoc.busy ? <Spinner /> : "安全登记（带 expected）"}
                            </button>
                            <button className="btn tiny ghost" onClick={() => setAssoc(null)}>取消</button>
                            {assoc.err && <span className="hint" style={{ color: "var(--bad)" }}>{assoc.err}</span>}
                            {assoc.done && (
                              <span className="row" style={{ gap: "4px" }}>
                                <span className="hint">
                                  已登记 item #{assoc.done.itemId}
                                  {assoc.done.assetIds.length ? " · asset #" + assoc.done.assetIds.join("、") : "（同 owner 幂等，未新增）"}
                                </span>
                                <button className="btn tiny" disabled={!props.onOpenItem} onClick={() => props.onOpenItem?.(assoc.done!.itemId)}>
                                  打开条目建版本关系…
                                </button>
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="row" style={{ marginTop: "6px" }}>
                <span className="hint">已选 {selectedCount} / {precheck.results.length}（只提交勾选的文件，不提交原目录）</span>
                <span className="spacer" />
                <button className="btn primary" disabled={importing || selectedCount === 0} onClick={doImportSelected}>
                  {importing ? <Spinner /> : "导入已选 " + selectedCount + " 个文件"}
                </button>
              </div>
            </div>
          )}
        </Section>

        <Section title="拖拽导入">
          {/* F7：本地拖入只由 App 级 GlobalDrop 处理（唯一入口）；这里只保留说明与「选择文件」。 */}
          <div className="drop" onDrop={onDrop} onClick={() => fileRef.current?.click()} title="点击选择文件；拖入请拖到页面任意位置">
            拖入文件 / 文件夹 / 路径文本：拖到页面任意位置即可（统一入口）
            <div className="hint" style={{ marginTop: "4px" }}>浏览器不提供本地绝对路径时，请改用「本地路径导入」粘贴。</div>
          </div>
          <div className="row wrap" style={{ marginTop: "6px" }}>
            {["C:\\Downloads\\a.zip", "/home/u/素材库/b.7z"].map((s) => (
              <button key={s} className="btn tiny" onClick={() => updatePaths((p) => mergePathDraft(p, [s]))} title="插入示例路径">+ 示例</button>
            ))}
          </div>
        </Section>
      </div>
      {dropDialog && createPortal(
        <div className="backdrop import-confirm-backdrop" onClick={() => { if (!importing) cancelPrecheck(); }}>
          <div className="drawer import-confirm" role="dialog" aria-modal="true" aria-label="确认导入文件" onClick={(event) => event.stopPropagation()}>
            <div className="drawer-head">
              <h3>确认导入文件</h3>
              <button className="btn" disabled={importing} onClick={cancelPrecheck}>取消</button>
            </div>
            <div className="import-confirm-body">
              <label>导入位置
                <select value={destinationMode} disabled={importing} onChange={(e) => setDestinationMode(e.target.value === "copy" ? "copy" : "in-place")}>
                  <option value="in-place">原位置登记</option>
                  <option value="copy">复制到指定目录</option>
                </select>
              </label>
              {destinationMode === "copy" && <>
                {props.roots.length > 0 && <label>已登记的库目录
                  <select value={props.roots.some((root) => root.enabled && root.path === destination) ? destination : ""} disabled={importing}
                    onChange={(e) => { if (e.target.value) setDestination(e.target.value); }}>
                    <option value="">请选择或填写其他目录</option>
                    {props.roots.filter((root) => root.enabled).map((root) => <option key={root.id} value={root.path}>{root.path}</option>)}
                  </select>
                </label>}
                <div className="row">
                  <input type="text" aria-label="目标文件夹" placeholder="输入目标文件夹的绝对路径" value={destination} disabled={importing} onChange={(e) => setDestination(e.target.value)} />
                  {chooseFolder && <button className="btn" disabled={importing} onClick={async () => {
                    const request = dropRequest.current;
                    try {
                      const folder = await chooseFolder(destination || undefined);
                      if (folder && request === dropRequest.current) setDestination(folder);
                    } catch { if (request === dropRequest.current) setDropError("无法打开文件夹选择器"); }
                  }}>浏览…</button>}
                </div>
                <div className="hint">会保留原文件。下次默认使用这个目录。</div>
              </>}
              <label>BOOTH 商品链接（可选）
                <input type="text" inputMode="url" value={boothLink} placeholder="https://booth.pm/ja/items/…" disabled={importing} onChange={(e) => setBoothLink(e.target.value)} />
              </label>
              <div className="hint">填写后，勾选的文件会归到同一个 BOOTH 商品下。</div>
              {prechecking && <div className="hint" role="status"><Spinner /> 正在检查文件…</div>}
              {precheck?.budget.truncated && <div className="notice">预检达到上限，只能导入下方显示的文件。</div>}
              {precheck && !precheckRows.length && <div className="hint">没有可导入的文件。</div>}
              {precheckRows.length > 0 && <div className="import-confirm-files">
                {precheckRows.map((row) => <label key={row.pathNorm} className="import-confirm-file">
                  <input type="checkbox" checked={selected[row.pathNorm] === true} disabled={!expectedOf(row) || importing} onChange={() => toggleRow(row.pathNorm)} />
                  <span><span className="mono">{row.path}</span><small>{row.match.pathCollision ? pathCollisionText(row.match.pathCollision) : summaryLabel(row.summary)} · {sizeText(row)}</small></span>
                </label>)}
              </div>}
              {dropError && <div className="err" role="alert">{dropError}</div>}
            </div>
            <div className="wb-footer">
              <button className="btn primary" disabled={prechecking || importing || selectedCount === 0 || (destinationMode === "copy" && !destination.trim())} onClick={doImportSelected}>
                {importing ? "正在提交…" : "导入 " + selectedCount + " 个文件"}
              </button>
            </div>
          </div>
        </div>, document.body,
      )}
    </div>
  );
}
