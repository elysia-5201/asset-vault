import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AvatarMatch, CategoryNode, JobRow, LibraryRootRow, TagRow } from "@core/contracts";
import {
  apiMode, categoryApiMessage, checkAppUpdate, describeError, getCategories, getCategoryCounts, getHealth,
  listAvatars, listItems, listJobs, listProjects, listRoots, listTags,
  onModeChange, patchItem, recordImport, retryConnect, jobAction as apiJobAction,
  type ProjectRow,
} from "./api";
import type { AvatarCard, CategoryCounts, CategoryStats, HealthResponse, ItemCardWeb, UpdateCheckResponse, ViewMode } from "./types";
import { formatBytes, formatDate, parseAtQuery, resolveAvatarNames } from "./util";
import { AvatarRail } from "./components/AvatarRail";
import { CategoryManager } from "./components/CategoryManager";
import { EMPTY_FILTERS, SearchBar, type FilterState } from "./components/SearchBar";
import { ItemCardView } from "./components/ItemCardView";
import { ItemDetail } from "./components/ItemDetail";
import { JobsPanel } from "./components/JobsPanel";
import { ImportPanel } from "./components/ImportPanel";
import { DuplicatesPanel } from "./components/DuplicatesPanel";
import { ScanPreviewPanel } from "./components/ScanPreviewPanel";
import { CategoryBatchBar } from "./components/CategoryBatchBar";
import { Spinner, ToastHost, useDebounced, type Toast } from "./components/ui";

const IMPORTED_KEY = "av.importedItems";

export default function App() {
  const [mode, setMode] = useState<ViewMode>(apiMode());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(1);
  const toast = useCallback((kind: "ok" | "bad" | "info", text: string) => {
    const id = toastSeq.current++;
    setToasts((t) => [...t.slice(-4), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "bad" ? 9000 : 4500);
  }, []);

  const [avatars, setAvatars] = useState<AvatarCard[]>([]);
  const [avatarsLoading, setAvatarsLoading] = useState(true);
  const [items, setItems] = useState<ItemCardWeb[]>([]);
  const [total, setTotal] = useState(0);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [itemsErr, setItemsErr] = useState("");
  const [tags, setTags] = useState<TagRow[]>([]);
  const [roots, setRoots] = useState<LibraryRootRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsAuto, setJobsAuto] = useState(true);
  const [health, setHealth] = useState<HealthResponse | null>(null);

  const [text, setText] = useState("");
  const debounced = useDebounced(text, 250);
  const [selectedAvatarIds, setSelectedAvatarIds] = useState<number[]>([]);
  const [avatarMatch, setAvatarMatch] = useState<AvatarMatch>("any");
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [filters, setFilters] = useState<FilterState>({ ...EMPTY_FILTERS });
  /** 分类树 + 统计（供筛选区与管理页用）；catErr 非空时显式提示后端未提供分类接口 */
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [catStats, setCatStats] = useState<CategoryStats | null>(null);
  const [catErr, setCatErr] = useState("");
  /** **当前筛选下**的分类计数（GET /api/categories/counts）；null = 端点不可用 → 退回树上的全局 itemCount */
  const [catCounts, setCatCounts] = useState<CategoryCounts | null>(null);
  /** 分类管理浮层 */
  const [managerOpen, setManagerOpen] = useState(false);
  /** 批量分类：选择模式（独立复选框，不复用整卡点击） */
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [importedIds, setImportedIds] = useState<number[]>([]);
  const [sideTab, setSideTab] = useState<"import" | "jobs">("import");
  /** 库级「查重」面板开关。 */
  const [dupPanel, setDupPanel] = useState(false);
  /** 扫描变更中心（M1）：先预览、确认后再写库。 */
  const [previewPanel, setPreviewPanel] = useState(false);
  /** 检查更新：正在请求 / 有更新时的面板数据（无更新只 toast，不弹面板）。 */
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResponse | null>(null);

  useEffect(() => {
    try { const raw = localStorage.getItem(IMPORTED_KEY); if (raw) setImportedIds(JSON.parse(raw) as number[]); } catch { /* 忽略 */ }
    return onModeChange((m) => { setMode(m); toast("info", m === "mock" ? "API 不可达，已切到内置 mock 数据（每 4 秒自动重连）" : "已连回后端，数据已刷新"); });
  }, [toast]);

  const persistImported = useCallback((ids: number[]) => {
    setImportedIds(ids);
    try { localStorage.setItem(IMPORTED_KEY, JSON.stringify(ids)); } catch { /* 忽略 */ }
  }, []);

  const loadAvatars = useCallback(() => {
    setAvatarsLoading(true);
    listAvatars().then((r) => setAvatars(r.avatars)).catch((e) => toast("bad", describeError(e))).finally(() => setAvatarsLoading(false));
  }, [toast]);

  const loadJobs = useCallback(() => {
    setJobsLoading(true);
    listJobs(undefined, 50).then((r) => setJobs(r.jobs)).catch((e) => toast("bad", describeError(e))).finally(() => setJobsLoading(false));
  }, [toast]);

  const loadCategories = useCallback(() => {
    getCategories()
      .then((r) => { setCategories(r.categories); setCatStats(r.stats); setCatErr(""); })
      .catch((e) => { setCategories([]); setCatStats(null); setCatErr(categoryApiMessage(e, "加载分类")); });
  }, []);

  const loadMeta = useCallback(() => {
    getHealth().then(setHealth).catch(() => setHealth(null));
    listTags().then((r) => setTags(r.tags)).catch(() => setTags([]));
    listRoots().then((r) => setRoots(r.roots)).catch(() => setRoots([]));
    listProjects().then((r) => setProjects(r.projects)).catch(() => setProjects([]));
  }, []);

  useEffect(() => { loadAvatars(); loadMeta(); loadJobs(); loadCategories(); }, [mode, loadAvatars, loadMeta, loadJobs, loadCategories]);

  // 启动后**静默**检查一次更新：有更新才弹面板，失败/已是最新都不打扰（离线可用性优先）。
  // 依赖 mode：内置 mock 模式下后端不可达，等切回 live 再试。
  useEffect(() => {
    if (mode !== "live") return;
    let alive = true;
    checkAppUpdate(false)
      .then((r) => { if (alive && r.ok && r.hasUpdate) setUpdateInfo(r); })
      .catch(() => { /* 静默 */ });
    return () => { alive = false; };
  }, [mode]);

  const doCheckUpdate = useCallback(() => {
    if (updateBusy) return;
    setUpdateBusy(true);
    checkAppUpdate(true)
      .then((r) => {
        if (!r.ok) { toast("bad", "检查更新失败：" + (r.error ?? "未知原因")); return; }
        if (r.hasUpdate) { setUpdateInfo(r); return; }
        toast("ok", "已是最新（v" + r.current + "）");
      })
      .catch((e) => toast("bad", "检查更新失败：" + describeError(e)))
      .finally(() => setUpdateBusy(false));
  }, [updateBusy, toast]);

  /** 卡片标签的颜色点：GET /api/tags 的 color 按名字索引（颜色不是身份，改名后自动跟随） */
  const tagColors = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of tags) if (t.color) m[t.name] = t.color;
    return m;
  }, [tags]);

  const parsed = useMemo(() => parseAtQuery(debounced), [debounced]);
  const resolved = useMemo(() => resolveAvatarNames(parsed.avatars, avatars), [parsed, avatars]);
  const effAvatarIds = useMemo(() => {
    const s = new Set(selectedAvatarIds);
    for (const id of resolved.ids) s.add(id);
    return [...s];
  }, [selectedAvatarIds, resolved.ids]);

  /**
   * 分类栏 → 查询参数：选一级 = 命中它（含其下所有子分类）；选二级 = 命中该子分类；
   * 系统分类「未分类」= uncategorized=1（cat_id 为空，与旧语义等价）。
   */
  const catQuery = useMemo(() => {
    const top = filters.catTop;
    if (!top || top === "uncategorized") {
      return { categoryIds: undefined as string[] | undefined, uncategorized: top === "uncategorized" };
    }
    return { categoryIds: [filters.catSub || top], uncategorized: false };
  }, [filters.catTop, filters.catSub]);

  /** 除分类以外的全部筛选（/api/items 与 /api/categories/counts 共用这一份口径）。 */
  const commonQuery = useMemo(() => ({
    q: parsed.q || undefined,
    avatar: effAvatarIds.length ? effAvatarIds : undefined,
    avatarMatch, ownedOnly,
    site: filters.site, status: filters.status, tag: filters.tag || undefined,
    container: filters.container,
    tags: filters.tags.length ? filters.tags : undefined,
    tagsMatch: filters.tagsMatch,
    favoriteOnly: filters.favoriteOnly || undefined,
    imported: (filters.imported === "any" ? undefined : filters.imported === "yes" ? 1 : 0) as 1 | 0 | undefined,
  }), [parsed.q, effAvatarIds.join(","), avatarMatch, ownedOnly, filters.site, filters.status, filters.tag, filters.container, filters.tags.join(","), filters.tagsMatch, filters.favoriteOnly, filters.imported]);

  const loadItems = useCallback(() => {
    setItemsLoading(true); setItemsErr("");
    listItems({
      ...commonQuery,
      // 组合筛选：分类 + 关键词 + 标签(ANY/ALL) + avatar(ANY/ALL) + 来源 + 状态 + 容器 + 已导入 + 收藏
      categoryIds: catQuery.categoryIds,
      uncategorized: catQuery.uncategorized || undefined,
      pendingCategory: filters.pendingCategory || undefined,
      sort: filters.sort, limit: 120,
    })
      .then((r) => { setItems(r.items); setTotal(r.total); })
      .catch((e) => setItemsErr(describeError(e)))
      .finally(() => setItemsLoading(false));
  }, [commonQuery, catQuery, filters.pendingCategory, filters.sort]);

  useEffect(() => { loadItems(); }, [loadItems]);

  // 分类计数：随**其它**筛选变化（分类选择本身不参与，否则只会剩被选中的那个分类）。
  // 端点不可用（旧后端 / 404）时静默退回树上的全局 itemCount，并在分类栏标注来源。
  const loadCounts = useCallback(() => {
    getCategoryCounts(commonQuery)
      .then(setCatCounts)
      .catch(() => setCatCounts(null));
  }, [commonQuery]);
  useEffect(() => { loadCounts(); }, [loadCounts, mode]);

  useEffect(() => {
    if (!jobsAuto) return;
    const t = setInterval(() => { listJobs(undefined, 50).then((r) => setJobs(r.jobs)).catch(() => { /* 保留旧列表 */ }); }, 3000);
    return () => clearInterval(t);
  }, [jobsAuto, mode]);

  // 首页卡片自动跟上：作业从"忙碌"变空闲时刷新；窗口重新聚焦/可见时刷新；可见状态下每 15s 兜底刷新一次。
  // （否则在详情页里加图、或后台作业建好条目后，网格会一直停在旧快照。）
  const busyJobs = useMemo(() => jobs.filter((j) => !["done", "failed", "cancelled", "abandoned"].includes(j.state)).length, [jobs]);
  const prevBusy = useRef(0);
  useEffect(() => {
    if (prevBusy.current > 0 && busyJobs === 0) loadItems();
    prevBusy.current = busyJobs;
  }, [busyJobs, loadItems]);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") { loadItems(); listJobs(undefined, 50).then((r) => setJobs(r.jobs)).catch(() => { /* ignore */ }); } };
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    const t = setInterval(refresh, 15000);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", onVisible); clearInterval(t); };
  }, [loadItems, mode]);

  // 「已导入」由服务端按 project_imports 过滤（GET /items?imported=1|0）；
  // 本地登记只用于卡片徽标（ItemCard 无 imported 字段）。
  const shownItems = items;

  const toggleSelect = (id: number) => setSelectedIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  /** 选中项里「未分类」的（cat_id IS NULL）——「仅对未分类批量」用 */
  const uncategorizedSelected = useMemo(
    () => items.filter((i) => selectedIds.includes(i.id) && !(i.category?.categoryId)).map((i) => i.id),
    [items, selectedIds],
  );

  const toggleAvatar = (id: number) => setSelectedAvatarIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const removeAtName = (name: string) => {
    const re = new RegExp("@(\"|')?" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\"|')?", "i");
    setText((t) => t.replace(re, "").replace(/\s+/g, " ").trim());
    const hit = resolved.ids.find((id) => avatars.find((a) => a.id === id)?.name === name);
    if (hit) setSelectedAvatarIds((s) => s.filter((x) => x !== hit));
  };

  const toggleFavorite = (item: ItemCardWeb) => {
    patchItem(item.id, { favorite: item.favorite ? 0 : 1 })
      .then(() => { loadItems(); toast("ok", item.favorite ? "已取消收藏" : "已收藏"); })
      .catch((e) => toast("bad", describeError(e)));
  };

  const doJobAction = async (id: number, action: "pause" | "resume" | "cancel" | "retry" | "abandon"): Promise<string> => {
    const r = await apiJobAction(id, action);
    const job: Partial<JobRow> = r.job ?? {};
    // 服务端可能返回裸 JobRow（实测）或 {job}；两者都容错，形状异常时回拉列表
    if (typeof job.id === "number" && typeof job.state === "string") {
      setJobs((js) => js.map((j) => (j.id === id ? (job as JobRow) : j)));
    } else {
      loadJobs();
    }
    return "作业 #" + id + " " + action + " → " + (job.state ?? "已提交") +
      (typeof job.attempts === "number" ? "（attempts=" + job.attempts + "）" : "");
  };

  const markImported = (itemId: number, projectId: number) => {
    recordImport(projectId, itemId)
      .then(() => { persistImported([...new Set([...importedIds, itemId])]); toast("ok", "已登记导入：item #" + itemId + " → project #" + projectId); })
      .catch((e) => toast("bad", describeError(e)));
  };

  const counts = health?.counts;
  const inFlight = jobs.filter((j) => ["queued", "resolving", "fetching", "materializing", "indexing", "matching", "releasing", "releasing_done"].includes(j.state)).length;

  return (
    <div className="app">
      <div className="col rail">
        <div className="brand">
          <span className="logo">AV</span>
          <span style={{ minWidth: 0 }}>
            <div className="t">AssetVault</div>
            <div className="s">
              {mode === "live" ? "后端 " + (typeof location !== "undefined" ? location.host : "") : "内置 mock 数据 · 正在重连"}
              {counts && typeof counts.items === "number" ? " · " + counts.items + " 条目 / " + counts.assets + " 资产" : ""}
            </div>
          </span>
          <span className="spacer" />
          <button className="btn tiny" title="库级查重：按资产内容签名聚类疑似重复（GET /api/duplicates）" onClick={() => setDupPanel(true)}>查重</button>
          <button
            className="btn tiny"
            title="分类管理：一级/二级分类的新增、改名、排序、移动、启停、删除、合并，以及标签管理"
            onClick={() => setManagerOpen(true)}
          >分类管理</button>
          <button
            className="btn tiny"
            title="扫描变更中心：先落库一份「这次会变成什么」的清单，勾选确认后再应用（不移动/不删除源文件）"
            onClick={() => setPreviewPanel(true)}
          >扫描预览</button>
          <button
            className="btn tiny"
            title="批量分类：在列表卡片上加复选框，可批量设置主/子分类、移除子分类、重新生成建议"
            onClick={() => { setSelectMode((v) => !v); setSelectedIds([]); }}
          >{selectMode ? "退出选择" : "批量分类"}</button>
          <button className="btn tiny" disabled={updateBusy} title="检查应用更新（GET /api/update-check?force=1，查 GitHub Releases）" onClick={doCheckUpdate}>
            {updateBusy ? "检查中…" : "检查更新"}
          </button>
          {mode === "mock" && (
            <button className="btn tiny" title="立刻再探一次后端（后台每 4 秒也会自动重连）" onClick={() => { void retryConnect().then((m) => { if (m === "mock") toast("bad", "还是连不上后端，继续每 4 秒重试…"); }); }}>重连</button>
          )}
          <span className={"mode-pill " + mode}>{mode === "live" ? "LIVE" : "MOCK"}</span>
        </div>
        <AvatarRail
          avatars={avatars} loading={avatarsLoading} selected={effAvatarIds} onToggle={toggleAvatar}
          onClear={() => { setSelectedAvatarIds([]); setText((t) => t.replace(/@(?:"[^"]+"|'[^']+'|[^\s@]+)/g, "").replace(/\s+/g, " ").trim()); }}
          ownedOnly={ownedOnly} onOwnedOnly={setOwnedOnly} match={avatarMatch} onMatch={setAvatarMatch} hits={total}
        />
      </div>

      <div className="col">
        <SearchBar
          text={text} onText={setText} filters={filters} onFilters={setFilters}
          atAvatars={parsed.avatars} unresolved={resolved.unresolved} onRemoveAt={removeAtName}
          tags={tags} loading={itemsLoading} total={total}
          categories={categories} catCounts={catCounts}
          countsScope={catCounts ? "filtered" : "global"} catErr={catErr}
        />
        {selectMode && (
          <CategoryBatchBar
            selectedIds={selectedIds}
            uncategorizedIds={uncategorizedSelected}
            categories={categories}
            catErr={catErr}
            onClearSelection={() => setSelectedIds([])}
            onExitSelectMode={() => { setSelectMode(false); setSelectedIds([]); }}
            onToast={toast}
            onDone={() => { loadItems(); loadCategories(); setSelectedIds([]); }}
          />
        )}
        <div className="col-scroll">
          {itemsErr && <div className="pane-body"><div className="err">{itemsErr}</div></div>}
          {!itemsErr && !itemsLoading && !shownItems.length && (
            <div className="empty">
              没有匹配的条目
              <div className="hint" style={{ marginTop: "6px" }}>{mode === "mock" ? "当前是内置 mock 数据（后端不可达）：左上角点「重连」，或等它每 4 秒自动重连。" : "试着放宽过滤器或清空 @头像。"}</div>
            </div>
          )}
          {itemsLoading && !shownItems.length && <div className="empty"><Spinner /> 载入条目…</div>}
          <div className="grid">
            {shownItems.map((it) => (
              <ItemCardView
                key={it.id} item={it} onOpen={setSelectedItemId} onToggleFavorite={toggleFavorite}
                imported={importedIds.includes(it.id) || filters.imported === "yes"}
                selectMode={selectMode} selected={selectedIds.includes(it.id)} onToggleSelect={toggleSelect}
                tagColors={tagColors}
              />
            ))}
          </div>
          {shownItems.length > 0 && (
            <div className="hint" style={{ padding: "0 12px 16px" }}>
              显示 {shownItems.length} / {total} 条 · 排序 {filters.sort} · {jobsAuto ? "作业自动刷新中" : "作业自动刷新已关"}
            </div>
          )}
        </div>
      </div>

      <div className="col side">
        <div className="pane-head" style={{ gap: "6px" }}>
          <div className="seg">
            <button className={sideTab === "import" ? "on" : ""} onClick={() => setSideTab("import")}>导入</button>
            <button className={sideTab === "jobs" ? "on" : ""} onClick={() => setSideTab("jobs")}>作业 {inFlight ? "(" + inFlight + ")" : ""}</button>
          </div>
          <span className="spacer" />
          <button className="btn tiny" onClick={() => { loadItems(); loadJobs(); loadMeta(); }}>全部刷新</button>
        </div>
        {sideTab === "import"
          ? <ImportPanel roots={roots} onToast={toast} onJobsChanged={loadJobs} onDataChanged={() => { loadItems(); loadMeta(); }} mode={mode} />
          : <JobsPanel jobs={jobs} loading={jobsLoading} auto={jobsAuto} onAuto={setJobsAuto} onRefresh={loadJobs} onAction={doJobAction} onToast={toast} />}
      </div>

      {/* 有更新才弹的居中面板：当前版本 → 最新版本 + Release 链接 + notes 前 500 字 + 资产文件名/大小 */}
      {updateInfo && (
        <div className="backdrop" onClick={() => setUpdateInfo(null)}>
          <div className="drawer update-panel" role="dialog" aria-label="发现新版本" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <h3>发现新版本</h3>
              {updateInfo.fromCache && <span className="badge muted" title="6 小时内已检查过，本次直接读缓存">缓存</span>}
              <span className="spacer" />
              <button className="btn" onClick={() => setUpdateInfo(null)}>关闭</button>
            </div>
            <div className="update-body">
              <div className="update-vers">
                <span className="mono">v{updateInfo.current}</span>
                <span className="update-arrow">→</span>
                <span className="mono update-latest">v{updateInfo.latest}</span>
              </div>
              <div className="hint">
                {updateInfo.publishedAt ? "发布于 " + formatDate(updateInfo.publishedAt) : "发布时间未知"}
                {updateInfo.assetName ? " · 资产 " + updateInfo.assetName + (updateInfo.assetSize ? "（" + formatBytes(updateInfo.assetSize) + "）" : "") : ""}
              </div>
              {updateInfo.notes ? (
                <div className="pre">{updateInfo.notes.slice(0, 500)}</div>
              ) : (
                <div className="hint">这个 Release 没有写说明。</div>
              )}
              <div className="row">
                {updateInfo.url && (
                  <a className="btn tiny" href={updateInfo.url} target="_blank" rel="noreferrer">打开 Release 页面</a>
                )}
                <span className="spacer" />
                <button className="btn tiny" disabled={updateBusy} onClick={doCheckUpdate}>{updateBusy ? "检查中…" : "再检查一次"}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {managerOpen && (
        <CategoryManager
          categories={categories} catStats={catStats} catErr={catErr} tags={tags}
          onClose={() => setManagerOpen(false)}
          onToast={toast}
          onChanged={() => { loadCategories(); loadItems(); loadCounts(); loadMeta(); }}
        />
      )}

      {/* 查重面板先渲染：点条目打开详情时，详情（后渲染、同 z-index）盖在它上面，关掉详情即回到面板 */}
      {previewPanel && (
        <ScanPreviewPanel roots={roots} onClose={() => setPreviewPanel(false)} onToast={toast} onChanged={() => { loadItems(); loadMeta(); }} />
      )}
      {dupPanel && (
        <DuplicatesPanel onClose={() => setDupPanel(false)} onOpenItem={setSelectedItemId} onToast={toast} />
      )}

      {selectedItemId !== null && (
        <ItemDetail
          itemId={selectedItemId} avatars={avatars} projects={projects} onClose={() => setSelectedItemId(null)}
          onChanged={loadItems} onToast={toast} importedIds={importedIds} onMarkImported={markImported}
          onOpenItem={setSelectedItemId}
        />
      )}

      <ToastHost toasts={toasts} onClose={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}

