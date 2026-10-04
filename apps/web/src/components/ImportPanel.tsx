import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import type { BoothItemMeta } from "@core/contracts";
import { boothPeek, describeError, importPaths, importUrl, scan, scanDryRun } from "../api";
import type { BoothPeekResponse, LibraryRootRow, ScanPlanItem, ViewMode } from "../types";
import { looksLikeBoothUrl, splitPaths, uriToPath } from "../util";
import { Badge, Section, Spinner } from "./ui";

export function ImportPanel(props: {
  roots: LibraryRootRow[];
  onToast: (kind: "ok" | "bad" | "info", text: string) => void;
  onJobsChanged: () => void;
  onDataChanged: () => void;
  mode: ViewMode;
}) {
  const [url, setUrl] = useState("");
  const [peek, setPeek] = useState<BoothPeekResponse | null>(null);
  const [peeking, setPeeking] = useState(false);
  const [paths, setPaths] = useState("");
  const [rootId, setRootId] = useState<number | "">(props.roots[0]?.id ?? "");
  const [scanPath, setScanPath] = useState("");
  const [deep, setDeep] = useState(true);
  const [hot, setHot] = useState(false);
  const [busy, setBusy] = useState("");
  const [plans, setPlans] = useState<ScanPlanItem[] | null>(null);

  // roots 是异步加载的：挂载时 props.roots 还是空数组，必须在到达后补选默认根，
  // 否则 scan/dryRun 会因缺 rootId 被服务端拒绝（INVALID_INPUT：需要 rootId 或 path）。
  useEffect(() => {
    if (rootId === "" && props.roots.length) setRootId(props.roots[0].id);
  }, [props.roots, rootId]);
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

  const doImportPaths = (list: string[]) => {
    if (!list.length) { props.onToast("bad", "没有可导入的路径"); return; }
    setBusy("paths");
    importPaths(list)
      .then((r) => { props.onToast("ok", "已起 import_file 作业 #" + r.jobId + "（" + list.length + " 条路径）"); props.onJobsChanged(); props.onDataChanged(); })
      .catch((e) => props.onToast("bad", describeError(e)))
      .finally(() => setBusy(""));
  };

  const doScan = () => {
    setBusy("scan");
    scan({ rootId: rootId === "" ? undefined : rootId, path: scanPath.trim() || undefined, deep })
      .then((r) => { props.onToast("ok", "已起 scan 作业 #" + r.jobId); props.onJobsChanged(); })
      .catch((e) => props.onToast("bad", describeError(e)))
      .finally(() => setBusy(""));
  };

  const doDryRun = () => {
    setBusy("dry");
    scanDryRun({ rootId: rootId === "" ? undefined : rootId, path: scanPath.trim() || undefined, deep })
      .then((r) => { setPlans(r.items); props.onToast("ok", "dryRun 预览：" + r.items.length + " 条待入库（未落库）"); })
      .catch((e) => props.onToast("bad", describeError(e)))
      .finally(() => setBusy(""));
  };

  const handleFiles = (files: FileList | null) => {
    if (!files || !files.length) return;
    const withPath = Array.from(files).map((f) => (f as File & { path?: string }).path).filter((p): p is string => !!p);
    if (withPath.length) { setPaths((p) => (p ? p + "\n" : "") + withPath.join("\n")); props.onToast("ok", "已接收 " + withPath.length + " 个文件路径"); }
    else props.onToast("info", "浏览器不暴露本地绝对路径，已忽略 " + files.length + " 个文件（请改用粘贴路径）");
  };

  const onDrop = (e: ReactDragEvent) => {
    e.preventDefault(); setHot(false);
    const dt = e.dataTransfer;
    const text = dt.getData("text/uri-list") || dt.getData("text/plain");
    const list = splitPaths(text || "");
    handleFiles(dt.files);
    if (list.length) { setPaths((p) => (p ? p + "\n" : "") + list.join("\n")); props.onToast("ok", "已接收 " + list.length + " 条路径"); }
  };

  const meta: BoothItemMeta | null = peek;

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

        <Section title="扫库">
          <div className="row">
            <select value={rootId} onChange={(e) => setRootId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">（不指定 root）</option>
              {props.roots.map((r) => <option key={r.id} value={r.id}>#{r.id} {r.path} [{r.mode}]</option>)}
            </select>
            <label className="chk" title="deep=true 递归子目录"><input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} />deep</label>
          </div>
          <div className="row" style={{ marginTop: "6px" }}>
            <input type="text" placeholder="可选：额外路径" value={scanPath} onChange={(e) => setScanPath(e.target.value)} />
            <button className="btn" disabled={busy === "dry"} onClick={doDryRun} title="POST /scan {dryRun:true} —— 只读预览，不落库">{busy === "dry" ? <Spinner /> : "预览"}</button>
            <button className="btn primary" disabled={busy === "scan"} onClick={doScan}>扫描</button>
          </div>
          {plans && (
            <div style={{ marginTop: "7px" }}>
              <div className="hint">dryRun 预览（不落库）：{plans.length} 条</div>
              <table className="kv">
                <tbody>
                  {plans.slice(0, 12).map((p, i) => (
                    <tr key={i}>
                      <td className="k">{p.sourceSite}</td>
                      <td>{p.title}
                        <div className="hint">{p.sourceItemId ?? "—"} · conf {p.confidence ?? "—"} · {p.assets} 资产</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {plans.length > 12 && <div className="hint">…另有 {plans.length - 12} 条</div>}
            </div>
          )}
        </Section>

        <Section title="本地路径导入">
          <textarea rows={4} placeholder={"%DOWNLOADS%/pkg.zip\n%LIBRARY%/素材库/abc 目录"} value={paths} onChange={(e) => setPaths(e.target.value)} />
          <div className="row" style={{ marginTop: "6px" }}>
            <input ref={fileRef} type="file" multiple style={{ display: "none" }} onChange={(e) => handleFiles(e.target.files)} />
            <button className="btn tiny" onClick={() => fileRef.current?.click()}>选择文件</button>
            <span className="spacer" />
            <button className="btn" disabled={busy === "paths"} onClick={() => doImportPaths(splitPaths(paths))}>导入 {splitPaths(paths).length || ""}</button>
          </div>
        </Section>

        <Section title="拖拽导入">
          <div
            className={"drop" + (hot ? " hot" : "")}
            onDragOver={(e) => { e.preventDefault(); setHot(true); }}
            onDragLeave={() => setHot(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
          >
            拖入文件 / 文件夹 / 路径文本（uri-list、纯文本）到此
            <div className="hint" style={{ marginTop: "4px" }}>浏览器不提供本地绝对路径时，请改用「本地路径导入」粘贴。</div>
          </div>
          <div className="row wrap" style={{ marginTop: "6px" }}>
            {["file:///%DOWNLOADS%/a.zip", "%LIBRARY%/素材库/b.7z"].map((s) => (
              <button key={s} className="btn tiny" onClick={() => setPaths((p) => (p ? p + "\n" : "") + uriToPath(s))} title="插入示例路径">+ 示例</button>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
