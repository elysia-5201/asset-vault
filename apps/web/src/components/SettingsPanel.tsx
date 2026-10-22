import { useEffect, useState } from "react";
import {
  addRoot, addWatch, describeError, getSettings, listRoots, listWatches, removeRoot, removeWatch, scan,
  stagingCleanup, stagingUsage, updateSettings,
} from "../api";
import type { LibraryRootRow, SettingsResponse, StagingCleanupResult, StagingUsage, WatchEntry } from "../types";
import { formatBytes, shortenPath } from "../util";
import { Badge, Spinner } from "./ui";

/**
 * 设置：库根（扫描范围）、收件箱监听、下载目录 / Unity MCP / 检查更新仓库与 token。
 * 这些端点早就有（GET/POST/DELETE /roots、/watch，GET/PUT /settings），此前只能调 API；
 * 这里补齐界面，并且每个操作都落到真实接口 + 明确的成功/失败提示。
 */
export function SettingsPanel(props: {
  onClose: () => void;
  onToast: (kind: "ok" | "bad" | "info", text: string) => void;
  onChanged: () => void;
}) {
  const [roots, setRoots] = useState<LibraryRootRow[]>([]);
  const [watches, setWatches] = useState<WatchEntry[]>([]);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [newRoot, setNewRoot] = useState("");
  const [newWatch, setNewWatch] = useState("");
  const [draft, setDraft] = useState({ downloadRoot: "", unityMcpUrl: "", updateRepo: "", updateToken: "" });
  // staging（导入落地包缓存）用量与清理
  const [staging, setStaging] = useState<StagingUsage | null>(null);
  const [stagingErr, setStagingErr] = useState("");
  const [olderDays, setOlderDays] = useState(7);
  const [dryResult, setDryResult] = useState<StagingCleanupResult | null>(null);
  const [cleanResult, setCleanResult] = useState<StagingCleanupResult | null>(null);

  const reload = () => Promise.all([listRoots(), listWatches(), getSettings()])
    .then(([r, w, s]) => {
      setRoots(r.roots); setWatches(w.watches); setSettings(s);
      setDraft({ downloadRoot: s.downloadRoot ?? "", unityMcpUrl: s.unityMcpUrl ?? "", updateRepo: s.updateRepo ?? "", updateToken: "" });
    })
    .catch((e) => setErr(describeError(e)));

  useEffect(() => { setLoading(true); void reload().finally(() => setLoading(false)); }, []);

  const loadStaging = () => {
    setStagingErr("");
    stagingUsage()
      .then((u) => setStaging(u))
      .catch((e) => setStagingErr(describeError(e)));
  };
  useEffect(() => { loadStaging(); }, []);

  /** dry-run：只预览会删多少，不动磁盘。 */
  const doStagingDryRun = () => run("staging 预览", async () => {
    const r = await stagingCleanup(olderDays, true);
    setDryResult(r);
    props.onToast("info", "dry-run：可清理 " + r.files + " 个文件 / " + formatBytes(r.bytes) +
      (r.failed ? "，预计失败 " + r.failed : ""));
  });

  /** 真清理：只删 unity-staging 里 N 天以前的落地包，不碰素材。 */
  const doStagingCleanup = () => run("staging 清理", async () => {
    if (!window.confirm("清理 unity-staging 中 " + olderDays + " 天以前的落地包？\n只删导入缓存，不删素材、不改工程。")) return;
    const r = await stagingCleanup(olderDays, false);
    setCleanResult(r);
    setDryResult(null);
    props.onToast("ok", "已清理 " + r.files + " 个文件，释放 " + formatBytes(r.bytes) +
      (r.failed ? "；失败 " + r.failed : ""));
    loadStaging();
  });

  const run = (label: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    fn().catch((e) => props.onToast("bad", label + "失败：" + describeError(e))).finally(() => setBusy(""));
  };

  const doAddRoot = () => run("添加库根", async () => {
    const p = newRoot.trim();
    if (!p) { props.onToast("bad", "先填库根路径"); return; }
    const r = await addRoot(p, "index_in_place");
    props.onToast("ok", "已添加库根 #" + r.id + "（就地索引，不改动你的文件）");
    setNewRoot(""); await reload(); props.onChanged();
  });

  const doDelRoot = (r: LibraryRootRow) => run("删除库根", async () => {
    if (!window.confirm("删掉库根 #" + r.id + "？\n只删索引根，不删磁盘文件；该根下的素材记录会保留（可再添加回来）。")) return;
    await removeRoot(r.id);
    props.onToast("info", "已删除库根 #" + r.id);
    await reload(); props.onChanged();
  });

  const doScan = (r: LibraryRootRow) => run("扫描", async () => {
    const j = await scan({ rootId: r.id });
    props.onToast("ok", "已起扫描作业 #" + j.jobId + "（可在右侧「作业」里看进度）");
  });

  const doAddWatch = () => run("添加监听", async () => {
    const p = newWatch.trim();
    if (!p) { props.onToast("bad", "先填要监听的目录"); return; }
    const r = await addWatch(p);
    props.onToast("ok", "已添加收件箱监听：" + p);
    setNewWatch(""); setWatches(r.watches);
  });

  const doDelWatch = (p: string) => run("删除监听", async () => {
    const r = await removeWatch(p);
    props.onToast("info", "已移除监听：" + p);
    setWatches(r.watches);
  });

  const doSave = () => run("保存设置", async () => {
    const patch: any = {};
    if (draft.downloadRoot.trim() && draft.downloadRoot.trim() !== settings?.downloadRoot) patch.downloadRoot = draft.downloadRoot.trim();
    if (draft.unityMcpUrl.trim() !== (settings?.unityMcpUrl ?? "")) patch.unityMcpUrl = draft.unityMcpUrl.trim();
    if (draft.updateRepo.trim() !== (settings?.updateRepo ?? "")) patch.updateRepo = draft.updateRepo.trim();
    if (draft.updateToken.trim()) patch.updateToken = draft.updateToken.trim();
    if (Object.keys(patch).length === 0) { props.onToast("info", "没有需要保存的改动"); return; }
    await updateSettings(patch);
    props.onToast("ok", "设置已保存" + (patch.updateToken ? "（token 已写入，之后只显示「已配置」）" : ""));
    await reload(); props.onChanged();
  });

  return (
    <div className="backdrop" onClick={props.onClose}>
      <div className="drawer" role="dialog" aria-label="设置" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>设置</h3>
          {loading && <Spinner />}
          {busy && <Badge tone="busy">{busy}…</Badge>}
          <span className="spacer" />
          <button className="btn" onClick={props.onClose}>关闭</button>
        </div>
        <div className="settings-body">
          {err && <div className="notice bad">设置接口不可用：{err}</div>}

          <div className="section">
            <h4>库根（扫描范围）</h4>
            <div className="hint" style={{ marginBottom: "6px" }}>
              默认「就地索引」：只读你的目录、不搬文件。扫到的东西进素材库，原件不动。
            </div>
            {roots.map((r) => (
              <div className="row" key={r.id} style={{ gap: "8px", padding: "4px 0", alignItems: "center" }}>
                <span className="mono hint">#{r.id}</span>
                <span className="mono p" title={r.path} style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortenPath(r.path, 72)}</span>
                <Badge tone={r.mode === "managed" ? "busy" : "muted"}>{r.mode === "managed" ? "托管" : "就地索引"}</Badge>
                {r.enabled ? null : <Badge tone="warn">已停用</Badge>}
                <button className="btn tiny" disabled={!!busy} onClick={() => doScan(r)}>扫描</button>
                <button className="btn tiny" disabled={!!busy} onClick={() => doDelRoot(r)}>删除</button>
              </div>
            ))}
            {!roots.length && !loading && <div className="hint">还没有库根。加一个目录就能开始扫。</div>}
            <div className="row" style={{ gap: "6px", marginTop: "8px" }}>
              <input style={{ flex: 1 }} value={newRoot} onChange={(e) => setNewRoot(e.target.value)} placeholder="例如 E:\game\vrchatcache\素材库 或 /mnt/e/game/..." />
              <button className="btn" disabled={!!busy} onClick={doAddRoot}>添加库根</button>
            </div>
          </div>

          <div className="section">
            <h4>收件箱监听</h4>
            <div className="hint" style={{ marginBottom: "6px" }}>
              把这些目录设成收件箱（比如 IDM / 浏览器下载目录）：新落盘的 zip/7z/rar/unitypackage 会自动建档入库。
            </div>
            {watches.map((w) => (
              <div className="row" key={w.path} style={{ gap: "8px", padding: "4px 0", alignItems: "center" }}>
                <span className="mono p" title={w.path} style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortenPath(w.path, 72)}</span>
                <Badge tone={w.enabled ? "ok" : "muted"}>{w.enabled ? "监听中" : "已停用"}</Badge>
                <button className="btn tiny" disabled={!!busy} onClick={() => doDelWatch(w.path)}>移除</button>
              </div>
            ))}
            {!watches.length && !loading && <div className="hint">没有监听目录。</div>}
            <div className="row" style={{ gap: "6px", marginTop: "8px" }}>
              <input style={{ flex: 1 }} value={newWatch} onChange={(e) => setNewWatch(e.target.value)} placeholder="例如 E:\Downloads\booth" />
              <button className="btn" disabled={!!busy} onClick={doAddWatch}>添加监听</button>
            </div>
          </div>

          <div className="section">
            <h4>导入落地缓存（staging）</h4>
            <div className="hint" style={{ marginBottom: "6px" }}>
              导入时把压缩包里的 .unitypackage 落到这个目录再交给 Unity。它只是缓存，可以随时清；**不会动素材、不改工程**。
            </div>
            {stagingErr ? (
              <div className="hint">staging 接口不可用：{stagingErr}</div>
            ) : (
              <div className="hint">
                当前用量：{staging ? formatBytes(staging.bytes) + " · " + staging.files + " 个文件" + (staging.dirs !== null ? " · " + staging.dirs + " 个目录" : "") : "载入中…"}
                <button className="btn tiny" style={{ marginLeft: "6px" }} disabled={!!busy} onClick={loadStaging}>刷新</button>
              </div>
            )}
            <div className="row" style={{ gap: "6px", marginTop: "8px", alignItems: "center" }}>
              <label className="chk">
                清理
                <input
                  type="number" min={0} value={olderDays}
                  onChange={(e) => setOlderDays(Math.max(0, Number(e.target.value) || 0))}
                  style={{ width: "64px" }}
                />
                天以前的
              </label>
              <button className="btn tiny" disabled={!!busy} onClick={doStagingDryRun}>预览清理（dry-run）</button>
              <button className="btn tiny danger" disabled={!!busy} onClick={doStagingCleanup}>执行清理</button>
            </div>
            {dryResult && (
              <div className="hint" data-staging="dry">
                dry-run：将删除 {dryResult.files} 个文件 / 释放 {formatBytes(dryResult.bytes)}
                {dryResult.failed ? "；预计失败 " + dryResult.failed + " 项（可能被占用）" : ""}
              </div>
            )}
            {cleanResult && (
              <div className="hint" data-staging="done">
                已清理 {cleanResult.files} 个文件 / 释放 {formatBytes(cleanResult.bytes)}
                {cleanResult.failed ? "；失败 " + cleanResult.failed + " 项" : ""}
              </div>
            )}
            <div className="hint" style={{ marginTop: "4px" }}>dry-run 只统计不删除；「执行清理」会二次确认。</div>
          </div>

          <div className="section">
            <h4>下载与集成</h4>
            <div className="hint" style={{ marginBottom: "6px" }}>数据目录：<span className="mono">{settings?.dataDir ?? "—"}</span></div>
            <label className="hint" style={{ display: "block", marginTop: "6px" }}>BOOTH 下载保存目录</label>
            <input style={{ width: "100%" }} value={draft.downloadRoot} onChange={(e) => setDraft((d) => ({ ...d, downloadRoot: e.target.value }))} placeholder="留空 = 数据目录下 downloads/" />
            <label className="hint" style={{ display: "block", marginTop: "6px" }}>Unity MCP 地址（可选，留空自动探测）</label>
            <input style={{ width: "100%" }} value={draft.unityMcpUrl} onChange={(e) => setDraft((d) => ({ ...d, unityMcpUrl: e.target.value }))} placeholder={settings?.unityMcpCandidates?.join(" → ") ?? "http://127.0.0.1:8080/mcp"} />
            <label className="hint" style={{ display: "block", marginTop: "6px" }}>检查更新用的仓库（owner/repo，留空用内置默认）</label>
            <input style={{ width: "100%" }} value={draft.updateRepo} onChange={(e) => setDraft((d) => ({ ...d, updateRepo: e.target.value }))} placeholder="elysia-5201/asset-vault" />
            <label className="hint" style={{ display: "block", marginTop: "6px" }}>
              GitHub token（可选，提升限流额度；{settings?.updateTokenSet ? "当前已配置" : "当前未配置"}）
            </label>
            <input style={{ width: "100%" }} type="password" value={draft.updateToken} onChange={(e) => setDraft((d) => ({ ...d, updateToken: e.target.value }))} placeholder={settings?.updateTokenSet ? "已配置（留空则不修改）" : "github_pat_…"} />
            <div className="hint" style={{ marginTop: "4px" }}>token 只进不出：保存后接口只回「是否已配置」，不会回显值。</div>
            <div className="row" style={{ gap: "6px", marginTop: "10px" }}>
              <button className="btn" disabled={!!busy} onClick={doSave}>保存设置</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
