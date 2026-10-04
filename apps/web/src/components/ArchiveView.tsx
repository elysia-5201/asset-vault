import { useEffect, useMemo, useState } from "react";
import type { ArchiveEntry, AssetRow, UnityPackageAsset } from "@core/contracts";
import { getAsset, getAssetTree, getUnityPackage, readEntry, reindexAsset, describeError, type EntryPreview } from "../api";
import { buildTree, extOf, filterTree, formatBytes, isImageish, isTextish, type TreeNode } from "../util";
import { Badge, Section } from "./ui";

function TreeNodeView(props: { node: TreeNode; depth: number; expanded: Set<string>; toggle: (p: string) => void; onFile: (p: string) => void }) {
  const { node } = props;
  const open = node.isDir ? props.expanded.has(node.path) : false;
  return (
    <>
      <div className={"tree-node " + (node.isDir ? "dir" : "file")} style={{ paddingLeft: 4 + props.depth * 12 }}>
        {node.isDir
          ? <span className="nm" onClick={() => props.toggle(node.path)}>{open ? "▾" : "▸"} 📁 {node.name}</span>
          : <span className="nm" onClick={() => props.onFile(node.path)} title="读取包内文件预览">📄 {node.name}</span>}
        <span className="sz">{node.isDir ? node.fileCount + " 项 · " + formatBytes(node.totalSize) : formatBytes(node.size)}</span>
      </div>
      {open && node.children.map((c) => <TreeNodeView key={c.path} node={c} depth={props.depth + 1} expanded={props.expanded} toggle={props.toggle} onFile={props.onFile} />)}
    </>
  );
}

export function ArchiveView(props: { asset: AssetRow; onToast: (kind: "ok" | "bad" | "info", text: string) => void }) {
  const { asset } = props;
  const isUp = asset.container === "unitypackage";
  const [tab, setTab] = useState<"tree" | "unitypackage">(isUp ? "unitypackage" : "tree");
  const [entries, setEntries] = useState<ArchiveEntry[]>([]);
  const [upAssets, setUpAssets] = useState<UnityPackageAsset[]>([]);
  const [upByType, setUpByType] = useState<Record<string, number> | null>(null);
  const [meta, setMeta] = useState<{ truncated?: boolean; passwordProtected?: boolean; note?: string }>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [needle, setNeedle] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<{ path: string; data: EntryPreview } | null>(null);
  const [assetAvatars, setAssetAvatars] = useState<{ avatar_id: number; entry_prefix: string | null; confidence: number; evidence: string | null }[]>([]);

  useEffect(() => {
    let alive = true;
    setErr(""); setPreview(null); setEntries([]); setUpAssets([]); setUpByType(null);
    getAsset(asset.id).then((d) => { if (alive) setAssetAvatars(d.avatars ?? []); }).catch(() => { /* 证据可缺省 */ });
    if (isUp) {
      setLoading(true);
      getUnityPackage(asset.id)
        .then((d) => { if (alive) { setUpAssets(d.assets); setUpByType(d.byType ?? null); setMeta({ truncated: d.truncated }); } })
        .catch((e) => { if (alive) setErr(describeError(e)); })
        .finally(() => { if (alive) setLoading(false); });
    } else {
      setLoading(true);
      getAssetTree(asset.id)
        .then((d) => { if (alive) { setEntries(d.entries); setMeta({ truncated: d.truncated, passwordProtected: d.passwordProtected, note: d.note }); } })
        .catch((e) => { if (alive) setErr(describeError(e)); })
        .finally(() => { if (alive) setLoading(false); });
    }
    return () => { alive = false; };
  }, [asset.id, isUp]);

  const tree = useMemo(() => filterTree(buildTree(entries), needle), [entries, needle]);
  const typeStats = useMemo<[string, number][]>(() => {
    if (upByType && Object.keys(upByType).length) {
      return Object.entries(upByType).sort((a, b) => b[1] - a[1]);
    }
    const m = new Map<string, number>();
    for (const a of upAssets) m.set(a.type ?? "(未知)", (m.get(a.type ?? "(未知)") ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [upAssets, upByType]);
  const maxType = typeStats.length ? typeStats[0][1] : 1;
  const upFiltered = useMemo(
    () => (needle ? upAssets.filter((a) => a.assetPath.toLowerCase().includes(needle.toLowerCase())) : upAssets),
    [upAssets, needle],
  );

  const toggle = (p: string) => setExpanded((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });

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
            <div className="evidence" key={i}>
              avatar_id={x.avatar_id} prefix={x.entry_prefix ?? "—"} conf={x.confidence.toFixed(2)} · {x.evidence ?? "无证据字段"}
            </div>
          ))}
        </div>
      )}
      <div className="seg" style={{ marginBottom: "6px" }}>
        <button className={tab === "tree" ? "on" : ""} onClick={() => setTab("tree")}>包内目录 ({entries.length})</button>
        <button className={tab === "unitypackage" ? "on" : ""} onClick={() => setTab("unitypackage")}>unitypackage 资产 ({upAssets.length})</button>
      </div>
      <input type="search" placeholder="过滤路径…" value={needle} onChange={(e) => setNeedle(e.target.value)} style={{ marginBottom: "6px" }} />
      {loading && <div className="hint"><span className="spin" /> 读取中…</div>}
      {err && <div className="err">{err}</div>}
      {meta.passwordProtected && <div className="err">压缩包已加密（ARCHIVE_PASSWORD），无法列目录</div>}
      {meta.truncated && <div className="notice">列表被截断（truncated=true），仅显示前 N 条</div>}
      {meta.note && <div className="hint">{meta.note}</div>}

      {tab === "tree" && !loading && !err && (
        tree.length
          ? <div className="tree">{tree.map((n) => <TreeNodeView key={n.path} node={n} depth={0} expanded={expanded} toggle={toggle} onFile={openFile} />)}</div>
          : <div className="hint">无条目</div>
      )}

      {tab === "unitypackage" && !loading && !err && (
        <>
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
              <div className="tree-node file" key={a.guid} title={a.guid}>
                <span className="nm">{a.hasPreview ? "🖼" : "📄"} {a.assetPath}</span>
                <span className="sz">{a.type ?? "?"} · {formatBytes(a.size)} · {a.guid.slice(0, 8)}</span>
              </div>
            ))}
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
