import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArchiveEntry, AssetRow, UnityPackageAsset } from "@core/contracts";
import { getAsset, getAssetTree, getUnityPackage, readEntry, reindexAsset, describeError, type EntryPreview } from "../api";
import { buildTree, extOf, filterTree, formatBytes, isImageish, isTextish, type TreeNode } from "../util";
import { Badge, EvidenceLine, Section } from "./ui";

/** 压缩包里解析出来的 .unitypackage 资产多带一个"来自哪个包"。 */
type UpAssetRow = UnityPackageAsset & { package?: string };
type PkgRow = { label: string; source: string; size: number; assets: number; note?: string };

/** 这些内层包可以直接点开看目录（zip 进程内直读；7z/rar 走各自后端）。 */
const NESTABLE = /\.(zip|7z|rar)$/i;

function TreeNodeView(props: {
  node: TreeNode; depth: number; expanded: Set<string>; toggle: (p: string) => void; onFile: (p: string) => void;
  canNest: boolean; nestedOpen: Set<string>; nested: Record<string, ArchiveEntry[]>; nestedBusy: string | null; onNested: (p: string) => void;
}) {
  const { node } = props;
  const open = node.isDir ? props.expanded.has(node.path) : false;
  const nestable = props.canNest && !node.isDir && NESTABLE.test(node.path);
  const nOpen = props.nestedOpen.has(node.path);
  const kids = props.nested[node.path] ?? [];
  const pad = (d: number) => ({ paddingLeft: 4 + d * 12 });
  return (
    <>
      <div className={"tree-node " + (node.isDir ? "dir" : "file")} style={pad(props.depth)}>
        {node.isDir
          ? <span className="nm" onClick={() => props.toggle(node.path)}>{open ? "▾" : "▸"} 📁 {node.name}</span>
          : nestable
            ? <span className="nm" onClick={() => props.onNested(node.path)} title="点开看这个内层压缩包的目录（嵌套只展开一层）">{nOpen ? "▾" : "▸"} 📦 {node.name}</span>
            : <span className="nm" onClick={() => props.onFile(node.path)} title="读取包内文件预览">📄 {node.name}</span>}
        <span className="sz">{node.isDir ? node.fileCount + " 项 · " + formatBytes(node.totalSize) : formatBytes(node.size)}</span>
      </div>
      {open && node.children.map((c) => <TreeNodeView key={c.path} {...props} node={c} depth={props.depth + 1} />)}
      {nestable && nOpen && (
        props.nestedBusy === node.path
          ? <div className="tree-node file" style={pad(props.depth + 1)}><span className="hint"><span className="spin" /> 解内层包…</span></div>
          : kids.length === 0
            ? <div className="tree-node file" style={pad(props.depth + 1)}><span className="hint">（内层包读不出条目）</span></div>
            : kids.map((e) => (
                <div className={"tree-node " + (e.isDir ? "dir" : "file")} key={node.path + "/" + e.path} style={pad(props.depth + 1)} title="内层包内容（预览请先解出来再看）">
                  <span className="nm">{e.isDir ? "📁 " : "📄 "}{e.path}</span>
                  {!e.isDir && <span className="sz">{formatBytes(e.size)}</span>}
                </div>
              ))
      )}
    </>
  );
}

export function ArchiveView(props: { asset: AssetRow; onToast: (kind: "ok" | "bad" | "info", text: string) => void }) {
  const { asset } = props;
  const isUp = asset.container === "unitypackage";
  const [tab, setTab] = useState<"tree" | "unitypackage">(isUp ? "unitypackage" : "tree");
  const [entries, setEntries] = useState<ArchiveEntry[]>([]);
  /** 按资产缓存解析结果：切 tab / 切资产不会把已经拿到的数据丢掉（也避免在 effect 里 setState 引发竞态）。 */
  const [pkgByAsset, setPkgByAsset] = useState<Record<number, { assets: UpAssetRow[]; byType: Record<string, number> | null; packages: PkgRow[]; truncated?: boolean; error?: string }>>({});
  const [pkgLoadingId, setPkgLoadingId] = useState<number | null>(null);
  const inFlight = useRef<Set<number>>(new Set());
  const mountedRef = useRef(true);
  const [meta, setMeta] = useState<{ truncated?: boolean; passwordProtected?: boolean; note?: string }>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [needle, setNeedle] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [nested, setNested] = useState<Record<string, ArchiveEntry[]>>({});
  const [nestedOpen, setNestedOpen] = useState<Set<string>>(new Set());
  const [nestedBusy, setNestedBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; data: EntryPreview } | null>(null);
  const [assetAvatars, setAssetAvatars] = useState<{ avatar_id: number; entry_prefix: string | null; confidence: number; evidence: string | null }[]>([]);

  // 资产切换：重置 + 拉"包内目录"（压缩包）或直接进 unitypackage 页（.unitypackage 本体）
  useEffect(() => {
    let alive = true;
    setErr(""); setPreview(null); setEntries([]);
    setNested({}); setNestedOpen(new Set()); setNeedle("");
    setTab(isUp ? "unitypackage" : "tree");
    getAsset(asset.id).then((d) => { if (alive) setAssetAvatars(d.avatars ?? []); }).catch(() => { /* 证据可缺省 */ });
    if (!isUp) {
      setLoading(true);
      getAssetTree(asset.id)
        .then((d) => { if (alive) { setEntries(d.entries); setMeta({ truncated: d.truncated, passwordProtected: d.passwordProtected, note: d.note }); } })
        .catch((e) => { if (alive) setErr(describeError(e)); })
        .finally(() => { if (alive) setLoading(false); });
    }
    return () => { alive = false; };
  }, [asset.id, isUp]);

  useEffect(() => () => { mountedRef.current = false; }, []);

  // unitypackage 页懒加载（压缩包要先把里面的 .unitypackage 解出来解析，别拖慢抽屉打开）
  useEffect(() => {
    if (tab !== "unitypackage") return;
    if (pkgByAsset[asset.id] || inFlight.current.has(asset.id)) return;
    inFlight.current.add(asset.id);
    setPkgLoadingId(asset.id);
    getUnityPackage(asset.id)
      .then((d) => {
        if (!mountedRef.current) return;
        setPkgByAsset((m) => ({ ...m, [asset.id]: { assets: d.assets as UpAssetRow[], byType: d.byType ?? null, packages: (d.packages ?? []) as PkgRow[], truncated: d.truncated } }));
      })
      .catch((e) => {
        if (!mountedRef.current) return;
        setPkgByAsset((m) => ({ ...m, [asset.id]: { assets: [], byType: null, packages: [], error: describeError(e) } }));
      })
      .finally(() => { inFlight.current.delete(asset.id); if (mountedRef.current) setPkgLoadingId(null); });
  }, [tab, asset.id, pkgByAsset]);

  const pkg = pkgByAsset[asset.id];
  const upAssets = pkg?.assets ?? [];
  const upByType = pkg?.byType ?? null;
  const upPackages = pkg?.packages ?? [];
  const upReady = !!pkg;
  const upLoading = pkgLoadingId === asset.id;

  // .unitypackage 本体：顺手用解析出来的资产路径把"包内目录"也填上（不然那一页永远是 0 条）
  useEffect(() => {
    if (isUp && upAssets.length && !entries.length) {
      setEntries(upAssets.map((a) => ({ path: a.assetPath, size: a.size ?? 0, isDir: false })));
      setMeta((m) => ({ ...m, note: "包内目录由 unitypackage 里的 pathname 生成" }));
    }
  }, [isUp, upAssets, entries.length]);

  const tree = useMemo(() => filterTree(buildTree(entries), needle), [entries, needle]);
  const typeStats = useMemo<[string, number][]>(() => {
    if (upByType && Object.keys(upByType).length) return Object.entries(upByType).sort((a, b) => b[1] - a[1]);
    const m = new Map<string, number>();
    for (const a of upAssets) m.set(a.type ?? "(未知)", (m.get(a.type ?? "(未知)") ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [upAssets, upByType]);
  const maxType = typeStats.length ? typeStats[0][1] : 1;
  const upFiltered = useMemo(
    () => (needle ? upAssets.filter((a) => a.assetPath.toLowerCase().includes(needle.toLowerCase())) : upAssets),
    [upAssets, needle],
  );
  const multiPkg = upPackages.length > 1;

  const toggle = (p: string) => setExpanded((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });

  const openNested = useCallback((p: string) => {
    setNestedOpen((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
    setNested((m) => {
      if (m[p]) return m;
      setNestedBusy(p);
      getAssetTree(asset.id, { nested: p })
        .then((d) => setNested((mm) => ({ ...mm, [p]: d.entries })))
        .catch((e) => { setNested((mm) => ({ ...mm, [p]: [] })); props.onToast("bad", "内层包读不出目录：" + describeError(e)); })
        .finally(() => setNestedBusy(null));
      return m;
    });
  }, [asset.id, props]);

  const openFile = (p: string) => {
    setPreview({ path: p, data: { contentType: "…", url: null, text: "载入中…" } });
    readEntry(asset.id, p)
      .then((d) => setPreview({ path: p, data: d }))
      .catch((e) => { setPreview(null); props.onToast("bad", describeError(e)); });
  };

  const doReindex = () => {
    reindexAsset(asset.id).then((r) => props.onToast("ok", "已起 reindex 作业 #" + r.jobId)).catch((e) => props.onToast("bad", describeError(e)));
  };

  return (
    <Section
      title={<>资产 #{asset.id} · {asset.container} · {formatBytes(asset.size)}</>}
      right={<button className="btn tiny" onClick={doReindex} title="POST /assets/:id/reindex">重解析</button>}
    >
      <div className="row wrap" style={{ marginBottom: "6px" }}>
        <Badge tone={asset.status === "present" ? "ok" : "warn"}>{asset.status}</Badge>
        <Badge>{asset.kind}</Badge>
        <Badge tone={asset.sha256_state === "ok" ? "ok" : "muted"}>sha256:{asset.sha256_state}</Badge>
        <Badge tone="muted">{asset.discovered_by}</Badge>
      </div>
      <div className="evidence" style={{ marginBottom: "6px" }} title="assets.path">{asset.path}</div>
      {assetAvatars.length > 0 && (
        <div style={{ marginBottom: "6px" }}>
          <div className="hint">该资产的适配模型证据（GET /assets/:id → avatars）</div>
          {assetAvatars.map((x, i) => (
            <EvidenceLine
              key={i} name={"avatar#" + x.avatar_id} prefix={x.entry_prefix} confidence={x.confidence} evidence={x.evidence} source={null}
            />
          ))}
        </div>
      )}
      <div className="seg" style={{ marginBottom: "6px" }}>
        <button className={tab === "tree" ? "on" : ""} onClick={() => setTab("tree")}>包内目录 ({entries.length})</button>
        <button className={tab === "unitypackage" ? "on" : ""} onClick={() => setTab("unitypackage")}>unitypackage 资产 ({upReady ? upAssets.length : "…"})</button>
      </div>
      <input type="search" placeholder="过滤路径…" value={needle} onChange={(e) => setNeedle(e.target.value)} style={{ marginBottom: "6px" }} />
      {loading && <div className="hint"><span className="spin" /> 读取中…</div>}
      {tab === "unitypackage" && upLoading && <div className="hint"><span className="spin" /> 解析包里的 .unitypackage…</div>}
      {err && <div className="err">{err}</div>}
      {meta.passwordProtected && <div className="err">压缩包已加密（ARCHIVE_PASSWORD），无法列目录</div>}
      {meta.truncated && <div className="notice">列表被截断（truncated=true），仅显示前 N 条</div>}
      {meta.note && <div className="hint">{meta.note}</div>}

      {tab === "tree" && !loading && !err && (
        <>
          {!isUp && entries.some((e) => NESTABLE.test(e.path)) && (
            <div className="hint" style={{ marginBottom: "4px" }}>📦 的行是内层压缩包，点一下展开它的目录</div>
          )}
          {tree.length
            ? <div className="tree">{tree.map((n) => (
                <TreeNodeView
                  key={n.path} node={n} depth={0} expanded={expanded} toggle={toggle} onFile={openFile}
                  canNest nestedOpen={nestedOpen} nested={nested} nestedBusy={nestedBusy} onNested={openNested}
                />
              ))}</div>
            : <div className="hint">无条目</div>}
        </>
      )}

      {tab === "unitypackage" && pkg?.error && <div className="err">{pkg.error}</div>}
      {tab === "unitypackage" && !upLoading && !err && (
        <>
          {upPackages.length > 0 && (
            <div style={{ marginBottom: "6px" }}>
              {upPackages.map((p, i) => (
                <div className="evidence" key={i} title={p.source}>
                  📦 {p.label} · {formatBytes(p.size)} · {p.assets} 项{p.note ? " · 来自 " + p.note : ""}
                </div>
              ))}
            </div>
          )}
          <div className="hint" style={{ marginBottom: "4px" }}>类型统计来源：{upByType ? "服务端 byType" : "前端按 assets[].type 统计"}</div>
          <div className="stat-bars" style={{ marginBottom: "7px" }}>
            {typeStats.map(([t, n]) => (
              <div className="stat-bar" key={t}>
                <span title={t}>{t}</span>
                <span className="track"><span className="fill" style={{ width: (n / maxType) * 100 + "%" }} /></span>
                <span>{n}</span>
              </div>
            ))}
          </div>
          <div className="tree">
            {upFiltered.map((a) => (
              <div className="tree-node file" key={(a.package ?? "") + a.guid} title={a.guid}>
                <span className="nm">{a.hasPreview ? "🖼" : "📄"} {a.assetPath}</span>
                <span className="sz">{multiPkg && a.package ? a.package + " · " : ""}{a.type ?? "?"} · {formatBytes(a.size)} · {a.guid.slice(0, 8)}</span>
              </div>
            ))}
            {!upFiltered.length && <div className="hint">{upAssets.length ? "过滤后无匹配" : "这个资产里没有解析出 .unitypackage 资产"}</div>}
          </div>
        </>
      )}

      {preview && (
        <div style={{ marginTop: "7px" }}>
          <div className="row">
            <span className="hint mono">{preview.path}</span>
            <span className="spacer" />
            <span className="hint">{preview.data.contentType}</span>
            <button className="btn tiny" onClick={() => { if (preview.data.url) URL.revokeObjectURL(preview.data.url); setPreview(null); }}>关闭预览</button>
          </div>
          {preview.data.url
            ? <img src={preview.data.url} alt="" style={{ maxWidth: "100%", maxHeight: "300px", borderRadius: "8px", marginTop: "5px" }} />
            : <div className="pre" style={{ marginTop: "5px" }}>{preview.data.text ?? "（空）"}</div>}
          {preview.data.text && !isTextish(extOf(preview.path)) && !isImageish(extOf(preview.path)) && (
            <div className="hint">非文本/图片扩展名，按文本前 64KB 预览</div>
          )}
        </div>
      )}
    </Section>
  );
}
