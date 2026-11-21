/**
 * 搭配清单面板（avatar-loadouts spec §7.2；P3-T4）。
 *
 * 真实读写已准 9 端点（apps/server/src/http/routes/loadouts.ts）：
 * 清单选择/新建/改名/删除（确认「只删清单，不删素材」）、条目卡（标题/状态 chip/只读证据/备注）、
 * 移出（不删 item 与素材）、回收站开关、拖拽只提交可见行。
 *
 * 边界：
 * - 状态是手动声明（准备使用/已导入（手动）/已验证（手动）），证据只读；不一致只提示、不自动改写。
 * - counts 三口径分开：stateCounts（整份清单，含回收站条目）/ trashedCount / 当前列表 total。
 * - 改名/改状态/改备注都用详情里的数值 version 做 CAS；缺 version 就拒绝提交，不拿 0/undefined 兜底。
 * - 父挂载（AvatarRail 入口、ItemDetail 按钮）归 P1-T5/task34；本组件只提供可接 props，不假称已主 UI 可用。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError, createLoadout, deleteLoadout, describeError, getLoadout, getProjectUsage, listAvatarLoadouts,
  patchLoadout, patchLoadoutItem, removeLoadoutItem, reorderLoadoutItems, scanProjectUsage, type ProjectRow,
} from "../api";
import type { Loadout, LoadoutDetail, LoadoutItem, LoadoutState } from "../types";
import {
  conflictHint, countsCaption, evidenceLabel, evidenceMark, listTotalCaption,
  reorderPayload, stateLabel, visibleReorderIds,
} from "../loadout-view";
import { Badge, Section, Spinner } from "./ui";
import { LoadoutMaterialPicker } from "./LoadoutMaterialPicker";
import type { LoadoutWorkbenchScope } from "../loadout-workbench";

const STATES: LoadoutState[] = ["planned", "imported", "verified"];
type ProjectUsage = { id: number; refs: Map<number, number> } | { id: number; error: string };

export interface LoadoutPanelProps {
  /** 面板只操作当前模型的清单。 */
  avatarId: number;
  /** 父可指定初始清单；缺省选第一份。 */
  initialLoadoutId?: number | null;
  onToast?: (kind: "ok" | "bad" | "info", text: string) => void;
  /** 清单/条目变化后通知父刷新（例如头像轨计数）。 */
  onChanged?: () => void;
  onOpenWorkbench?: (scope: LoadoutWorkbenchScope) => void;
  projects?: ProjectRow[];
  onRegisterCurrentProject?: () => Promise<number>;
}

export function LoadoutPanel(props: LoadoutPanelProps) {
  const [loadouts, setLoadouts] = useState<Loadout[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(props.initialLoadoutId ?? null);
  const [loadedDetail, setDetail] = useState<LoadoutDetail | null>(null);
  const detail = loadedDetail?.loadout.id === selectedId ? loadedDetail : null;
  const detailRequest = useRef(0);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [includeTrashed, setIncludeTrashed] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState<Record<number, string>>({});
  const [dragId, setDragId] = useState<number | null>(null);
  const [pickingFor, setPickingFor] = useState<number | null>(null);
  const [workbenchSelection, setWorkbenchSelection] = useState<number[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const project = props.projects?.find((row) => row.id === selectedProjectId);
  const projectId = project?.id;
  const [usage, setUsage] = useState<ProjectUsage | null>(null);
  const [usageRevision, setUsageRevision] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [scanNotice, setScanNotice] = useState("");
  const [registering, setRegistering] = useState(false);
  const currentUsage = usage?.id === projectId ? usage : null;
  const projectRefs = currentUsage && "refs" in currentUsage ? currentUsage.refs : null;

  const toast = (kind: "ok" | "bad" | "info", text: string) => props.onToast?.(kind, text);

  useEffect(() => {
    if (projectId === undefined) return;
    const controller = new AbortController();
    getProjectUsage(projectId, controller.signal).then(({ items }) => {
      if (controller.signal.aborted) return;
      const refs = new Map(items.filter((item) => item.files > 0).map((item) => [item.itemId, item.files]));
      setUsage({ id: projectId, refs });
    }).catch((e) => {
      if (!controller.signal.aborted) setUsage({ id: projectId, error: describeError(e) });
    });
    return () => controller.abort();
  }, [projectId, usageRevision]);

  const reloadUsage = () => {
    setUsage(null);
    setUsageRevision((n) => n + 1);
  };

  const selectProject = (id: number | null) => {
    if (id === selectedProjectId) return;
    setSelectedProjectId(id);
    setUsage(null);
    setScanNotice("");
  };

  const register = async () => {
    if (!props.onRegisterCurrentProject || registering) return;
    setRegistering(true);
    try {
      selectProject(await props.onRegisterCurrentProject());
    } catch (e) {
      toast("bad", describeError(e));
    } finally {
      setRegistering(false);
    }
  };

  const scan = async () => {
    if (!project || scanning) return;
    setScanning(true);
    setScanNotice("");
    try {
      const result = await scanProjectUsage(project.id);
      if (result.truncated || result.remaining) {
        setScanNotice("本次只扫描了部分文件，未确认的素材可能已在工程中。");
      }
      reloadUsage();
    } catch (e) {
      toast("bad", "扫描工程引用失败 · " + describeError(e));
    } finally {
      setScanning(false);
    }
  };

  const loadList = useCallback(() => {
    setLoading(true); setError("");
    listAvatarLoadouts(props.avatarId)
      .then((res) => {
        setLoadouts(res.loadouts);
        setSelectedId((cur) => {
          if (cur !== null && res.loadouts.some((l) => l.id === cur)) return cur;
          const wanted = props.initialLoadoutId;
          if (wanted !== undefined && wanted !== null && res.loadouts.some((l) => l.id === wanted)) return wanted;
          return res.loadouts.length ? res.loadouts[0].id : null;
        });
      })
      .catch((e) => setError(describeError(e)))
      .finally(() => setLoading(false));
  }, [props.avatarId, props.initialLoadoutId]);

  const loadDetail = useCallback(() => {
    const request = ++detailRequest.current;
    if (selectedId === null) { setDetail(null); setDetailLoading(false); return; }
    setDetailLoading(true); setError("");
    // 只按 includeTrashedItems 取；不加未准 state 筛选（否则所见集合与 reorder 的可见集不一致）。
    // limit 取已准上限 500：默认 100 会静默截断，使 reorder 提交的可见集不完整（server 判 400）。
    getLoadout(selectedId, { includeTrashedItems: includeTrashed, limit: 500 })
      .then((res) => { if (request === detailRequest.current) setDetail(res); })
      .catch((e) => { if (request === detailRequest.current) setError(describeError(e)); })
      .finally(() => { if (request === detailRequest.current) setDetailLoading(false); });
  }, [selectedId, includeTrashed]);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { setWorkbenchSelection([]); }, [selectedId]);
  useEffect(() => {
    loadDetail();
    return () => { detailRequest.current += 1; };
  }, [loadDetail]);

  /** 统一执行：409 明确「已被其他操作修改，请刷新」并重载（本地 version 已过期）。 */
  const run = (key: string, p: Promise<unknown>, okText: string, after?: () => void) => {
    setBusy(key);
    p.then(() => { toast("ok", okText); after?.(); loadList(); loadDetail(); props.onChanged?.(); })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 409) {
          toast("bad", "已被其他操作修改，请刷新（" + describeError(e) + "）");
          loadList(); loadDetail();
        } else toast("bad", describeError(e));
      })
      .finally(() => setBusy(""));
  };

  const create = () => {
    const name = newName.trim();
    if (!name) { toast("bad", "清单名不能为空"); return; }
    setBusy("create");
    createLoadout(props.avatarId, { name })
      .then((res) => {
        setNewName("");
        setSelectedId(res.loadout.id);
        setPickingFor(res.loadout.id);
        toast("ok", "已新建清单「" + res.loadout.name + "」");
        loadList();
        props.onChanged?.();
      })
      .catch((e) => toast("bad", describeError(e)))
      .finally(() => setBusy(""));
  };

  const rename = () => {
    if (!detail) return;
    const name = renaming.trim();
    if (!name) { toast("bad", "清单名不能为空"); return; }
    const version = detail.loadout.version;
    // 真正 CAS：必须用详情里的数值 version；缺就拒绝，不拿 0/undefined 兜底。
    if (typeof version !== "number") { toast("bad", "缺少清单 version，先刷新详情再改名"); return; }
    run("rename", patchLoadout(detail.loadout.id, { name, expectedVersion: version }), "已改名为「" + name + "」", () => setRenaming(""));
  };

  /**
   * 删除清单：成功后只清选择/详情/错误并刷新列表，**不走 run 的详情重载** ——
   * run 的 loadDetail 闭包持有删除前的 selectedId，会 GET 已删 id 触发 404 横幅。
   */
  const removeLoadout = (l: Loadout) => {
    setConfirmDelete(null);
    setBusy("delete:" + l.id);
    return deleteLoadout(l.id)
      .then(() => {
        toast("ok", "已删除清单「" + l.name + "」（只删清单，不删素材）");
        if (selectedId === l.id) { setSelectedId(null); setDetail(null); setError(""); }
        loadList();
        props.onChanged?.();
      })
      .catch((e) => toast("bad", describeError(e)))
      .finally(() => setBusy(""));
  };

  const setState = (it: LoadoutItem, state: LoadoutState) => {
    if (!detail) return;
    run("state:" + it.itemId, patchLoadoutItem(detail.loadout.id, it.itemId, { state, expectedVersion: it.version }),
      "已改为「" + stateLabel(state) + "」（手动声明）");
  };

  const saveNote = (it: LoadoutItem) => {
    if (!detail) return;
    const raw = noteDraft[it.itemId] ?? it.note ?? "";
    const note = raw.trim();
    run("note:" + it.itemId, patchLoadoutItem(detail.loadout.id, it.itemId, { note: note === "" ? null : note, expectedVersion: it.version }),
      "备注已保存（本清单内独立）");
  };

  const removeItem = (it: LoadoutItem) => {
    if (!detail) return;
    run("remove:" + it.itemId, removeLoadoutItem(detail.loadout.id, it.itemId), "已移出清单（条目与素材都保留）",
      () => setWorkbenchSelection((ids) => ids.filter((id) => id !== it.itemId)));
  };

  /** 拖拽：只在当前可见行内换位，提交 visibleIds + hiddenIds=[]（不先加载隐藏行）。 */
  const dropOn = (targetId: number) => {
    if (!detail || dragId === null) return;
    // 截断门（handler 侧）：只显示前 limit 行时，提交的可见集不完整，server 会判 400；直接拒绝。
    if (detail.total > detail.items.length) {
      setDragId(null);
      toast("bad", "列表被截断（显示 " + detail.items.length + " / 共 " + detail.total + " 条），不能拖拽排序");
      return;
    }
    const ids = visibleReorderIds(detail.items);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    setDragId(null);
    if (from < 0 || to < 0 || from === to) return;
    const next = ids.slice();
    const moved = next.splice(from, 1)[0];
    next.splice(to, 0, moved);
    run("reorder", reorderLoadoutItems(detail.loadout.id, reorderPayload(next, [])), "顺序已保存");
  };

  const selected = loadouts.find((l) => l.id === selectedId) ?? null;
  const availableItems = detail?.items.filter((it) => it.item.status !== "trashed") ?? [];
  const selectedItems = availableItems.filter((it) => workbenchSelection.includes(it.itemId));
  const unconfirmedItems = projectRefs ? availableItems.filter((it) => !projectRefs.has(it.itemId)) : [];
  const canSend = !!detail && !detailLoading && busy === "" && !registering && !scanning
    && (!project || !!project.path.trim());
  const sendToWorkbench = (items: LoadoutItem[]) => {
    if (!canSend || !detail || !items.length) return;
    props.onOpenWorkbench?.({
      id: detail.loadout.id,
      name: detail.loadout.name,
      avatarId: props.avatarId,
      items: items.map((it) => ({ id: it.itemId, title: it.item.title })),
      project: project && { name: project.name, path: project.path },
    });
  };
  const toggleWorkbenchItem = (itemId: number) => {
    setWorkbenchSelection((ids) => ids.includes(itemId) ? ids.filter((id) => id !== itemId) : [...ids, itemId]);
  };
  // 截断门（属性侧）：total > items.length 说明只拿到前 limit 行，拖拽会提交不完整可见集。
  const truncated = detail !== null && detail.total > detail.items.length;

  return (
    <Section
      title={<>搭配清单 {loadouts.length > 0 && <Badge tone="muted">{loadouts.length}</Badge>}</>}
      right={<button className="btn tiny" onClick={() => { loadList(); loadDetail(); if (project) reloadUsage(); }}
        disabled={loading || detailLoading || busy !== "" || scanning}>{loading || detailLoading ? "…" : "刷新"}</button>}
    >
      {error && <div className="hint" style={{ color: "var(--bad)" }}>{error}</div>}

      <div className="row wrap" style={{ gap: "6px" }}>
        <select
          value={selectedId ?? ""}
          onChange={(e) => {
            setSelectedId(e.target.value === "" ? null : Number(e.target.value));
            setPickingFor(null);
            setRenaming("");
            setConfirmDelete(null);
            setNoteDraft({});
          }}
          disabled={busy !== ""}
          aria-label="选择清单"
        >
          <option value="">选择清单…</option>
          {loadouts.map((l) => <option key={l.id} value={l.id}>{l.name}（{l.itemCount}）</option>)}
        </select>
        {selected && (
          <button className="btn primary" disabled={!detail || busy !== ""} aria-expanded={pickingFor === selected.id} onClick={() => setPickingFor(pickingFor === selected.id ? null : selected.id)}>
            {pickingFor === selected.id ? "收起素材选择" : "添加素材"}
          </button>
        )}
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (!loading && busy === "" && newName.trim()) create(); }}>
          <input type="text" value={newName} aria-label="新清单名称" placeholder="新清单名称" maxLength={80} onChange={(e) => setNewName(e.target.value)} />
          <button className="btn" disabled={loading || busy !== "" || !newName.trim()}>{busy === "create" ? <Spinner /> : "新建清单"}</button>
        </form>
      </div>

      {!loading && !error && loadouts.length === 0 && (
        <div className="hint">新建清单后即可在这里挑选素材。</div>
      )}

      {selected && detail && pickingFor === selected.id && (
        <LoadoutMaterialPicker
          key={selected.id}
          avatarId={props.avatarId}
          loadoutId={selected.id}
          existingItems={detail.items}
          disabled={busy !== "" || detailLoading}
          onSaving={(saving) => setBusy(saving ? "add" : "")}
          onAdded={(count, existing) => {
            toast("ok", `已加入 ${count} 项${existing ? `，${existing} 项已在清单中` : ""}`);
            loadList(); loadDetail(); props.onChanged?.();
          }}
        />
      )}

      {detail && (
        <>
          <div className="hint" style={{ marginTop: "4px" }}>
            {countsCaption({ stateCounts: detail.stateCounts, trashedCount: detail.trashedCount })}
          </div>
          <div className="hint">
            {listTotalCaption(detail.total, { state: null, includeTrashed })}
            {detail.trashedCount > 0 && !includeTrashed ? " · 回收站条目默认隐藏" : ""}
          </div>
          {selected && (
            <details className="loadout-settings">
              <summary>清单设置</summary>
              <div className="row wrap">
                <input type="text" value={renaming} aria-label="修改清单名称" placeholder="改名…" maxLength={80} onChange={(e) => setRenaming(e.target.value)} />
                <button className="btn tiny" disabled={busy !== "" || !renaming.trim()} onClick={rename}>改名</button>
                <label className="chk">
                  <input type="checkbox" checked={includeTrashed} onChange={(e) => setIncludeTrashed(e.target.checked)} disabled={busy !== ""} />
                  显示回收站
                </label>
                <span className="spacer" />
                {confirmDelete === selected.id
                  ? <><button className="btn tiny" onClick={() => setConfirmDelete(null)}>取消</button><button className="btn tiny danger" disabled={busy !== ""} onClick={() => removeLoadout(selected)}>确认删除清单（保留素材）</button></>
                  : <button className="btn tiny danger" disabled={busy !== ""} onClick={() => setConfirmDelete(selected.id)}>删除清单</button>}
              </div>
            </details>
          )}

          {truncated && (
            <div className="hint" style={{ color: "var(--warn)" }}>
              当前显示前 {detail.items.length} / {detail.total} 项。批量选择只覆盖显示的素材，拖拽排序已禁用。
            </div>
          )}

          {detail.items.length === 0 && pickingFor !== selectedId && <div className="hint">点击「添加素材」开始搭配。</div>}

          {props.projects && (
            <div className="loadout-project">
              <div className="row wrap">
                <label htmlFor="loadout-project">Unity 工程</label>
                <select id="loadout-project" value={projectId ?? ""} title={project?.path} disabled={scanning || registering}
                  onChange={(e) => selectProject(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">选择工程</option>
                  {props.projects.map((p) => <option key={p.id} value={p.id} title={p.path}>{p.name}</option>)}
                </select>
                {project && <button className="btn" disabled={scanning || registering || !project.path.trim()} onClick={() => void scan()}>
                  {scanning ? "扫描引用中…" : "扫描工程引用"}
                </button>}
                {props.onRegisterCurrentProject && <button className="btn ghost" disabled={registering || scanning}
                  onClick={() => void register()}>{registering ? "正在登记…" : "登记当前 Unity 工程"}</button>}
              </div>
              {project && <div className="hint loadout-project-path">{project.path || "此工程缺少路径，请登记当前 Unity 工程。"}</div>}
              {project && !currentUsage && <div className="hint" role="status">正在读取工程引用…</div>}
              {currentUsage && "error" in currentUsage && (
                <div className="row wrap">
                  <span className="err-text" role="alert">{currentUsage.error}</span>
                  <button className="btn tiny" disabled={scanning} onClick={reloadUsage}>重试</button>
                </div>
              )}
              {projectRefs && <div className="row wrap loadout-project-counts" role="status">
                <Badge tone="ok">已有引用 {availableItems.length - unconfirmedItems.length}</Badge>
                <Badge tone="muted">未确认 {unconfirmedItems.length}</Badge>
                {unconfirmedItems.length > 0 && <span className="hint">未确认的素材可能已在工程中，可扫描工程引用后核对。</span>}
              </div>}
              {scanNotice && <div className="hint loadout-project-notice">{scanNotice}</div>}
            </div>
          )}

          {props.onOpenWorkbench && availableItems.length > 0 && (
            <div className="row wrap loadout-import">
              <button className="btn" disabled={detailLoading || busy !== ""} onClick={() => {
                setWorkbenchSelection(selectedItems.length === availableItems.length ? [] : availableItems.map((item) => item.itemId));
              }}>{selectedItems.length === availableItems.length ? "取消全选" : "全选可见素材"}</button>
              <span className="hint" role="status">已选 {selectedItems.length} 项</span>
              <span className="spacer" />
              {projectRefs && unconfirmedItems.length > 0 && <button className="btn" disabled={!canSend}
                onClick={() => sendToWorkbench(unconfirmedItems)}>仅送未确认项（{unconfirmedItems.length}）</button>}
              <button className="btn primary" disabled={!canSend || !selectedItems.length}
                onClick={() => sendToWorkbench(selectedItems)}>送到 Unity 工作台</button>
            </div>
          )}

          {detail.items.map((it) => {
            const hint = conflictHint(it.state, it.evidence);
            const trashed = it.item.status === "trashed";
            const files = projectRefs?.get(it.itemId);
            return (
              <div
                key={it.itemId}
                draggable={!truncated && busy === ""}
                onDragStart={() => setDragId(it.itemId)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => dropOn(it.itemId)}
                style={{ borderTop: "1px solid var(--line-soft)", padding: "6px 0", opacity: trashed ? 0.75 : 1 }}
              >
                <div className="row wrap" style={{ gap: "6px" }}>
                  <span className="hint" title="拖拽排序（只提交当前可见行）">⋮⋮</span>
                  {props.onOpenWorkbench && <input type="checkbox" aria-label={"导入 " + it.item.title}
                    checked={!trashed && workbenchSelection.includes(it.itemId)} disabled={trashed || detailLoading || busy !== ""}
                    onChange={() => toggleWorkbenchItem(it.itemId)} />}
                  <b>{it.item.title}</b>
                  <Badge tone={it.state === "verified" ? "ok" : it.state === "imported" ? "warn" : "muted"}>{stateLabel(it.state)}</Badge>
                  {trashed && <Badge tone="bad">回收站</Badge>}
                  {projectRefs && !trashed && <Badge tone={files ? "ok" : "muted"}>
                    {files ? `已有引用 · ${files} 个文件` : "引用未确认"}
                  </Badge>}
                  <span className="hint">#{it.itemId} · v{it.version}</span>
                  <span className="spacer" />
                  <select value={it.state} disabled={busy !== ""} onChange={(e) => setState(it, e.target.value as LoadoutState)} title="清单状态（手动声明）">
                    {STATES.map((s) => <option key={s} value={s}>{stateLabel(s)}</option>)}
                  </select>
                  <button className="btn tiny danger" disabled={busy !== ""} onClick={() => removeItem(it)}>移出</button>
                </div>
                {!project && <>
                  <div className="hint" style={{ marginTop: "2px" }}>
                    全部工程的证据 · {evidenceLabel("registered")} {evidenceMark(it.evidence.registered)} · {evidenceLabel("referenced")} {evidenceMark(it.evidence.referenced)} · {evidenceLabel("verified")} {evidenceMark(it.evidence.verified)}
                  </div>
                  {hint && <div className="hint" style={{ color: "var(--warn)" }}>{hint}</div>}
                </>}
                <div className="row wrap" style={{ gap: "6px", marginTop: "3px" }}>
                  <input
                    type="text"
                    value={noteDraft[it.itemId] ?? it.note ?? ""}
                    placeholder="备注（本清单内独立）"
                    onChange={(e) => setNoteDraft((s) => ({ ...s, [it.itemId]: e.target.value }))}
                  />
                  <button className="btn tiny" disabled={busy !== ""} onClick={() => saveNote(it)}>保存备注</button>
                </div>
              </div>
            );
          })}
        </>
      )}
    </Section>
  );
}
