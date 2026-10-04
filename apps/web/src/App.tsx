import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AvatarMatch, JobRow, LibraryRootRow, TagRow } from "@core/contracts";
import {
  apiMode, describeError, getHealth, listAvatars, listItems, listJobs, listProjects, listRoots, listTags,
  onModeChange, patchItem, recordImport, jobAction as apiJobAction,
  type ProjectRow,
} from "./api";
import type { AvatarCard, HealthResponse, ItemCardWeb, ViewMode } from "./types";
import { parseAtQuery, resolveAvatarNames } from "./util";
import { AvatarRail } from "./components/AvatarRail";
import { SearchBar, type FilterState } from "./components/SearchBar";
import { ItemCardView } from "./components/ItemCardView";
import { ItemDetail } from "./components/ItemDetail";
import { JobsPanel } from "./components/JobsPanel";
import { ImportPanel } from "./components/ImportPanel";
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
  const [filters, setFilters] = useState<FilterState>({ site: "", status: "", container: "", tag: "", imported: "any", sort: "updated" });
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [importedIds, setImportedIds] = useState<number[]>([]);
  const [sideTab, setSideTab] = useState<"import" | "jobs">("import");

  useEffect(() => {
    try { const raw = localStorage.getItem(IMPORTED_KEY); if (raw) setImportedIds(JSON.parse(raw) as number[]); } catch { /* 忽略 */ }
    return onModeChange((m) => { setMode(m); toast("info", m === "mock" ? "API 不可达，已切换到内置 mock 数据" : "已连接后端 API"); });
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

  const loadMeta = useCallback(() => {
    getHealth().then(setHealth).catch(() => setHealth(null));
    listTags().then((r) => setTags(r.tags)).catch(() => setTags([]));
    listRoots().then((r) => setRoots(r.roots)).catch(() => setRoots([]));
    listProjects().then((r) => setProjects(r.projects)).catch(() => setProjects([]));
  }, []);

  useEffect(() => { loadAvatars(); loadMeta(); loadJobs(); }, [mode, loadAvatars, loadMeta, loadJobs]);

  const parsed = useMemo(() => parseAtQuery(debounced), [debounced]);
  const resolved = useMemo(() => resolveAvatarNames(parsed.avatars, avatars), [parsed, avatars]);
  const effAvatarIds = useMemo(() => {
    const s = new Set(selectedAvatarIds);
    for (const id of resolved.ids) s.add(id);
    return [...s];
  }, [selectedAvatarIds, resolved.ids]);

  const loadItems = useCallback(() => {
    setItemsLoading(true); setItemsErr("");
    listItems({
      q: parsed.q || undefined, avatar: effAvatarIds.length ? effAvatarIds : undefined,
      avatarMatch, ownedOnly, site: filters.site, status: filters.status, tag: filters.tag || undefined,
      container: filters.container,
      imported: filters.imported === "any" ? undefined : filters.imported === "yes" ? 1 : 0,
      sort: filters.sort, limit: 120,
    })
      .then((r) => { setItems(r.items); setTotal(r.total); })
      .catch((e) => setItemsErr(describeError(e)))
      .finally(() => setItemsLoading(false));
  }, [parsed.q, effAvatarIds.join(","), avatarMatch, ownedOnly, filters]);

  useEffect(() => { loadItems(); }, [loadItems]);

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
              {mode === "live" ? "后端 127.0.0.1:7317" : "内置 mock 数据"}
              {counts && typeof counts.items === "number" ? " · " + counts.items + " 条目 / " + counts.assets + " 资产" : ""}
            </div>
          </span>
          <span className="spacer" />
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
          tags={tags.map((t) => t.name)} loading={itemsLoading} total={total}
        />
        <div className="col-scroll">
          {itemsErr && <div className="pane-body"><div className="err">{itemsErr}</div></div>}
          {!itemsErr && !itemsLoading && !shownItems.length && (
            <div className="empty">
              没有匹配的条目
              <div className="hint" style={{ marginTop: "6px" }}>{mode === "mock" ? "当前为内置 mock 数据；启动后端 (npx tsx apps/server/src/main.ts) 后刷新即切换。" : "试着放宽过滤器或清空 @头像。"}</div>
            </div>
          )}
          {itemsLoading && !shownItems.length && <div className="empty"><Spinner /> 载入条目…</div>}
          <div className="grid">
            {shownItems.map((it) => (
              <ItemCardView
                key={it.id} item={it} onOpen={setSelectedItemId} onToggleFavorite={toggleFavorite}
                imported={importedIds.includes(it.id) || filters.imported === "yes"}
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

      {selectedItemId !== null && (
        <ItemDetail
          itemId={selectedItemId} avatars={avatars} projects={projects} onClose={() => setSelectedItemId(null)}
          onChanged={loadItems} onToast={toast} importedIds={importedIds} onMarkImported={markImported}
        />
      )}

      <ToastHost toasts={toasts} onClose={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}

