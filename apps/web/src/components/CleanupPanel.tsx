/**
 * 整理待办面板（cleanup-todos spec §6.1–§6.3 / §7.2；P4-T4）。
 *
 * 真实读写已准 8 端点（apps/server/src/http/routes/cleanup.ts）：
 * 四类 rule tab + 计数、搜索、头像/分类筛选、已忽略显示、独立「已忽略管理」（含 resolved/粘性恢复）、
 * 保存筛选（应用/新增/改名/删除，PATCH 用数值 version 做 CAS，409 提示刷新并重拉）。
 *
 * 边界：
 * - local 策略必选、无「未选」态；主 UI 默认 include_local（用户 m00868 已准），每个 GET 都显式传。
 * - POST ignore 返回的是 include_local 视图，不作为所选策略的真相：成功后按当前策略重拉 todos。
 * - counts 是规则命中计数（ignored 不影响），与当前列表 total 分页口径不同；counts.<rule>.ignored 是命中子集。
 * - missing_file 是库内标记（上次扫描/确认），不是实时磁盘检查。
 * - 不自动 scan/repair/删文件/改条目状态；只提供跳详情与忽略/恢复。
 * - 父挂载（App 入口/onOpenItem）归 task34；本组件只提供可接 props，不假称已主 UI 可用。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError, apiMode, createCleanupFilter, deleteCleanupFilter, describeError, getCategories,
  ignoreCleanupTodo, listAvatars, listCleanupFilters, listCleanupIgnores, listCleanupTodos,
  restoreCleanupIgnore, updateCleanupFilter,
} from "../api";
import type {
  AvatarCard, CategoryNode, CleanupFilterRow, CleanupIgnoresResponse, CleanupRule,
  CleanupTodoRow, CleanupTodosResponse, LocalSourcePolicy,
} from "../types";
import {
  CLEANUP_RULES, DEFAULT_LOCAL_POLICY, MISSING_FILE_NOTE, countsCaption, countsTotal, evidenceText,
  filterBody, resolvedLabel, ruleLabel, savedFilterToState, type CleanupListState,
} from "../cleanup-view";
import { Badge, Section, Spinner, STATUS_LABEL, useDebounced } from "./ui";
import { ItemCardView } from "./ItemCardView";

export interface CleanupPanelProps {
  /** 跳条目详情；父挂载（task34）提供。缺省时只提示，不伪造跳转。 */
  onOpenItem?: (id: number) => void;
  onToast?: (kind: "ok" | "bad" | "info", text: string) => void;
  /** 从条目详情返回时刷新当前待办列表。 */
  refreshKey?: number;
}

/** 错误文案：mock 模式真缺能力要明示，不伪写成功。 */
function errorText(e: unknown): string {
  const base = describeError(e);
  return apiMode() === "mock" ? "内置 mock 模式未实现整理待办（不伪造成功）：" + base : base;
}

function flattenCategories(nodes: CategoryNode[], depth = 0): { node: CategoryNode; depth: number }[] {
  const out: { node: CategoryNode; depth: number }[] = [];
  for (const n of nodes) {
    out.push({ node: n, depth });
    if (n.children && n.children.length > 0) out.push(...flattenCategories(n.children, depth + 1));
  }
  return out;
}

export function CleanupPanel(props: CleanupPanelProps) {
  const [rule, setRule] = useState<CleanupRule | null>(null);
  const [q, setQ] = useState("");
  const debouncedQ = useDebounced(q, 300);
  const [avatarIds, setAvatarIds] = useState<number[]>([]);
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [ignored, setIgnored] = useState<"hide" | "show" | "only">("hide");
  const [sort, setSort] = useState<"updated" | "title">("updated");
  const [policy, setPolicy] = useState<LocalSourcePolicy>(DEFAULT_LOCAL_POLICY);
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<CleanupTodosResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [avatars, setAvatars] = useState<AvatarCard[]>([]);
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [filters, setFilters] = useState<CleanupFilterRow[]>([]);
  const [selectedFilterId, setSelectedFilterId] = useState<number | null>(null);
  const [filterName, setFilterName] = useState("");
  const [renaming, setRenaming] = useState("");
  const [confirmDeleteFilter, setConfirmDeleteFilter] = useState<number | null>(null);
  const [managementOpen, setManagementOpen] = useState(false);
  const [resolvedFilter, setResolvedFilter] = useState<"any" | "true" | "false">("any");
  const [ignores, setIgnores] = useState<CleanupIgnoresResponse | null>(null);
  const [ignoresLoading, setIgnoresLoading] = useState(false);
  const [ignoresError, setIgnoresError] = useState("");
  const todoRequest = useRef(0);

  const toast = (kind: "ok" | "bad" | "info", text: string) => props.onToast?.(kind, text);

  /** 当前 UI 条件 → 保存筛选 JSON 的共同来源（策略必选）。 */
  const listState: CleanupListState = {
    rule, q, avatarIds, categoryIds, ignored, sort,
    localSourcePolicy: policy, limit, offset,
  };

  const reloadTodos = useCallback(() => {
    const request = ++todoRequest.current;
    setLoading(true); setError("");
    listCleanupTodos({
      rule: rule ?? undefined, ignored, q: debouncedQ, avatarIds, categoryIds, sort,
      localSourcePolicy: policy, limit, offset,
    })
      .then((result) => { if (request === todoRequest.current) setData(result); })
      .catch((e) => { if (request === todoRequest.current) setError(errorText(e)); })
      .finally(() => { if (request === todoRequest.current) setLoading(false); });
  }, [rule, debouncedQ, avatarIds, categoryIds, ignored, sort, policy, limit, offset]);

  const reloadIgnores = useCallback(() => {
    if (!managementOpen) { setIgnores(null); return; }
    setIgnoresLoading(true); setIgnoresError("");
    listCleanupIgnores({ resolved: resolvedFilter, localSourcePolicy: policy, limit: 100 })
      .then(setIgnores)
      .catch((e) => setIgnoresError(errorText(e)))
      .finally(() => setIgnoresLoading(false));
  }, [managementOpen, resolvedFilter, policy]);

  const reloadFilters = useCallback(() => {
    listCleanupFilters()
      .then((res) => setFilters(res.filters))
      .catch((e) => toast("bad", errorText(e)));
  }, [props.onToast]);

  useEffect(() => { reloadTodos(); }, [reloadTodos, props.refreshKey]);
  useEffect(() => { reloadIgnores(); }, [reloadIgnores, props.refreshKey]);
  useEffect(() => { reloadFilters(); }, [reloadFilters]);
  useEffect(() => {
    // 过滤选项失败不阻塞列表；不伪造选项。
    listAvatars().then((res) => setAvatars(res.avatars)).catch(() => { /* 选项降级 */ });
    getCategories().then((res) => setCategories(res.categories)).catch(() => { /* 选项降级 */ });
  }, []);

  const openItem = (id: number) => {
    if (props.onOpenItem) props.onOpenItem(id);
    else toast("info", "详情入口由父挂载（task34）提供");
  };

  const favoriteHint = () => toast("info", "收藏状态请在条目详情里改（本面板不改条目）");

  /** 忽略：POST 后按所选策略重拉 todos（POST 的 resolved 是 include_local 视图，不当真相）。 */
  const ignoreRow = (row: CleanupTodoRow) => {
    setBusy("ignore:" + row.item.id + ":" + row.rule);
    ignoreCleanupTodo({ itemId: row.item.id, rule: row.rule })
      .then(() => {
        toast("ok", "已忽略（resolved 由服务端按所选策略求值）");
        reloadTodos();
        if (managementOpen) reloadIgnores();
      })
      .catch((e) => toast("bad", errorText(e)))
      .finally(() => setBusy(""));
  };

  /** 恢复=删忽略行；问题仍在则回到列表，问题已解决则自然不出现。 */
  const restoreIgnore = (itemId: number, rule: CleanupRule) => {
    setBusy("restore:" + itemId + ":" + rule);
    restoreCleanupIgnore(itemId, rule)
      .then(() => {
        toast("ok", "已恢复（问题仍在则回到列表）");
        reloadTodos();
        if (managementOpen) reloadIgnores();
      })
      .catch((e) => toast("bad", errorText(e)))
      .finally(() => setBusy(""));
  };

  /** 保存当前条件：filter 用服务端实际键，策略取当前所选（不是硬编码 include_local）。 */
  const saveFilter = () => {
    const name = filterName.trim();
    if (!name) { toast("bad", "筛选名不能为空"); return; }
    setBusy("save-filter");
    createCleanupFilter({ name, filter: filterBody(listState) })
      .then((res) => {
        toast("ok", "已保存筛选「" + res.filter.name + "」");
        setFilterName("");
        setSelectedFilterId(res.filter.id);
        reloadFilters();
      })
      .catch((e) => toast("bad", errorText(e)))
      .finally(() => setBusy(""));
  };

  /** 改名：必须用列表里的数值 version 做 CAS；409 提示刷新并重拉，不静默覆盖。 */
  const renameFilter = () => {
    const target = filters.find((f) => f.id === selectedFilterId);
    if (!target) { toast("bad", "先选择要改名的保存筛选"); return; }
    const name = renaming.trim();
    if (!name) { toast("bad", "筛选名不能为空"); return; }
    setBusy("rename-filter");
    updateCleanupFilter(target.id, { name, expectedVersion: target.version })
      .then((res) => {
        toast("ok", "已改名为「" + res.filter.name + "」");
        setRenaming("");
        reloadFilters();
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 409) {
          toast("bad", "已被其他操作修改，请刷新（" + describeError(e) + "）");
          reloadFilters();
        } else toast("bad", errorText(e));
      })
      .finally(() => setBusy(""));
  };

  const deleteFilter = () => {
    const target = filters.find((f) => f.id === selectedFilterId);
    if (!target) { toast("bad", "先选择要删除的保存筛选"); return; }
    setBusy("delete-filter");
    deleteCleanupFilter(target.id)
      .then(() => {
        toast("ok", "已删除筛选「" + target.name + "」");
        if (selectedFilterId === target.id) setSelectedFilterId(null);
        setConfirmDeleteFilter(null);
        reloadFilters();
      })
      .catch((e) => toast("bad", errorText(e)))
      .finally(() => setBusy(""));
  };

  /** 应用保存筛选：恢复条件（策略必选），offset 归零。 */
  const applyFilter = (id: number) => {
    const target = filters.find((f) => f.id === id);
    if (!target) return;
    const next = savedFilterToState(target.filter);
    setRule(next.rule ?? null);
    setQ(next.q ?? "");
    setAvatarIds(next.avatarIds ?? []);
    setCategoryIds(next.categoryIds ?? []);
    setIgnored(next.ignored ?? "hide");
    setSort(next.sort ?? "updated");
    setPolicy(next.localSourcePolicy);
    setLimit(next.limit ?? 50);
    setOffset(0);
    setSelectedFilterId(id);
    toast("info", "已应用筛选「" + target.name + "」");
  };

  const total = data?.total ?? 0;
  const shown = data?.items.length ?? 0;
  const from = shown === 0 ? 0 : offset + 1;
  const to = offset + shown;
  const catOptions = flattenCategories(categories);

  return (
    <Section
      title={<>整理待办 {data && <Badge tone="muted">{data.total}</Badge>}</>}
      right={<button className="btn tiny" onClick={() => { reloadTodos(); reloadFilters(); reloadIgnores(); }} disabled={loading}>{loading ? "…" : "刷新"}</button>}
    >
      {error && <div className="hint" style={{ color: "var(--bad)" }}>{error}</div>}

      <div className="row wrap" style={{ gap: "6px" }}>
        <div className="seg">
          <button className={rule === null ? "on" : ""} onClick={() => { setRule(null); setOffset(0); }}>全部 {data ? countsTotal(data.counts) : "…"}</button>
          {CLEANUP_RULES.map((r) => (
            <button key={r} className={rule === r ? "on" : ""} onClick={() => { setRule(r); setOffset(0); }}>
              {ruleLabel(r)} {data ? data.counts[r].total : "…"}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <label className="chk" title="local 来源策略必选；无服务端默认">
          本地条目
          <select
            value={policy}
            onChange={(e) => { setPolicy(e.target.value === "exclude_local" ? "exclude_local" : "include_local"); setOffset(0); }}
            title="local 来源策略（必选；无服务端默认）"
          >
            <option value="exclude_local">排除本地条目</option>
            <option value="include_local">包含本地条目</option>
          </select>
        </label>
      </div>

      {data && <div className="hint" style={{ marginTop: "4px" }}>{countsCaption(data.counts)}</div>}
      {data && (
        <div className="hint">
          当前列表 {data.total} 行（分页口径）；tab 数字是规则命中计数，两者口径不同。
          {ignored === "only" ? "「只看已忽略」以忽略表为驱动，含已解决/陈旧行。" : ""}
        </div>
      )}

      <div className="row wrap" style={{ gap: "6px", marginTop: "8px" }}>
        <input type="search" aria-label="搜索整理待办" value={q} placeholder="搜索标题、店铺、作者、备注或标签" onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
      </div>

      <details className="batch-secondary" style={{ marginTop: "6px" }}>
        <summary>高级筛选与管理</summary>
      <div className="row wrap" style={{ gap: "6px", marginTop: "6px" }}>
        <select
          multiple
          size={3}
          value={avatarIds.map(String)}
          onChange={(e) => { setAvatarIds(Array.from(e.target.selectedOptions).map((o) => Number(o.value)).filter((n) => Number.isFinite(n))); setOffset(0); }}
          title="头像筛选（命中任一；可多选）"
        >
          {avatars.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select
          multiple
          size={3}
          value={categoryIds}
          onChange={(e) => { setCategoryIds(Array.from(e.target.selectedOptions).map((o) => o.value)); setOffset(0); }}
          title="分类筛选（命中任一；可多选）"
        >
          {catOptions.map(({ node, depth }) => (
            <option key={node.id} value={node.id}>{"　".repeat(depth) + node.name}</option>
          ))}
        </select>
        <select
          value={ignored}
          onChange={(e) => { setIgnored(e.target.value === "show" ? "show" : e.target.value === "only" ? "only" : "hide"); setOffset(0); }}
          title="已忽略显示"
        >
          <option value="hide">隐藏已忽略</option>
          <option value="show">显示已忽略</option>
          <option value="only">只看已忽略</option>
        </select>
        <select value={sort} onChange={(e) => { setSort(e.target.value === "title" ? "title" : "updated"); setOffset(0); }} title="排序">
          <option value="updated">最近更新</option>
          <option value="title">标题</option>
        </select>
      </div>

      <div className="row wrap" style={{ gap: "6px", marginTop: "6px" }}>
        <select
          value={selectedFilterId ?? ""}
          onChange={(e) => { const id = Number(e.target.value); if (id > 0) applyFilter(id); else setSelectedFilterId(null); }}
          title="应用保存筛选"
        >
          <option value="">选择保存筛选…</option>
          {filters.map((f) => <option key={f.id} value={f.id}>{f.name}（v{f.version}）</option>)}
        </select>
        <input value={filterName} placeholder="新筛选名（1..80）" onChange={(e) => setFilterName(e.target.value)} />
        <button className="btn tiny" disabled={busy !== ""} onClick={saveFilter}>{busy === "save-filter" ? <Spinner /> : "保存当前条件"}</button>
        <input value={renaming} placeholder="改名…" onChange={(e) => setRenaming(e.target.value)} />
        <button className="btn tiny" disabled={busy !== "" || selectedFilterId === null} onClick={renameFilter}>改名</button>
        {confirmDeleteFilter !== null && confirmDeleteFilter === selectedFilterId
          ? <button className="btn tiny danger" disabled={busy !== ""} onClick={deleteFilter}>确认删除筛选？</button>
          : <button className="btn tiny danger" disabled={busy !== "" || selectedFilterId === null} onClick={() => setConfirmDeleteFilter(selectedFilterId)}>删除筛选</button>}
      </div>

      <div className="row wrap" style={{ gap: "6px", marginTop: "6px" }}>
        <button className="btn tiny" onClick={() => setManagementOpen((v) => !v)}>{managementOpen ? "收起已忽略管理" : "已忽略管理"}</button>
        {managementOpen && (
          <select
            value={resolvedFilter}
            onChange={(e) => setResolvedFilter(e.target.value === "true" ? "true" : e.target.value === "false" ? "false" : "any")}
            title="按 resolved 过滤忽略行"
          >
            <option value="any">全部忽略行</option>
            <option value="true">问题当前不存在</option>
            <option value="false">问题当前存在</option>
          </select>
        )}
      </div>

      {managementOpen && (
        <div style={{ borderTop: "1px solid var(--line-soft)", marginTop: "6px", paddingTop: "6px" }}>
          <div className="hint">
            独立列出全部忽略行（含归档/回收站条目）；resolved 按所选策略单条求值，不套待办基础范围。
          </div>
          {ignoresError && <div className="hint" style={{ color: "var(--bad)" }}>{ignoresError}</div>}
          {ignoresLoading && <div className="hint"><Spinner /> 加载忽略行…</div>}
          {ignores && ignores.ignores.length === 0 && <div className="hint">没有忽略行。</div>}
          {ignores && ignores.ignores.map((ig) => (
            <div key={ig.itemId + ":" + ig.rule} style={{ borderTop: "1px solid var(--line-soft)", padding: "4px 0" }}>
              <div className="row wrap" style={{ gap: "6px" }}>
                <b>{ig.item.title}</b>
                <Badge tone="warn">{ruleLabel(ig.rule)}</Badge>
                <span className="hint">#{ig.itemId} · {STATUS_LABEL[ig.item.status]}</span>
                <span className="hint">{resolvedLabel(ig.resolved)}</span>
                {ig.note && <span className="hint">备注：{ig.note}</span>}
                <span className="spacer" />
                <button className="btn tiny" disabled={busy !== ""} onClick={() => restoreIgnore(ig.itemId, ig.rule)}>恢复</button>
              </div>
            </div>
          ))}
        </div>
      )}

      </details>

      {!loading && !error && data && data.items.length === 0 && (
        <div className="hint" style={{ marginTop: "6px" }}>当前条件下没有待办行。</div>
      )}

      {data && data.items.length > 0 && (
        <div className="grid" style={{ padding: "8px 0" }}>
          {data.items.map((row) => (
            <div key={row.item.id + ":" + row.rule} style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 }}>
              <ItemCardView item={row.item} onOpen={openItem} onToggleFavorite={favoriteHint} imported={false} />
              <div className="row wrap" style={{ gap: "4px" }}>
                <Badge tone="warn">{ruleLabel(row.rule)}</Badge>
                {row.ignored && <Badge tone="muted">已忽略</Badge>}
                {row.ignored && resolvedLabel(row.resolved) !== "" && <span className="hint">{resolvedLabel(row.resolved)}</span>}
                <span className="spacer" />
                {row.ignored
                  ? <button className="btn tiny" disabled={busy !== ""} onClick={() => restoreIgnore(row.item.id, row.rule)}>恢复</button>
                  : <button className="btn tiny" disabled={busy !== ""} onClick={() => ignoreRow(row)}>忽略</button>}
              </div>
              <div className="hint">证据：{evidenceText(row)}</div>
              {row.rule === "missing_file" && <div className="hint" style={{ color: "var(--warn)" }}>{MISSING_FILE_NOTE}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="row wrap" style={{ gap: "6px", marginTop: "4px" }}>
        <span className="hint">第 {from}–{to} 行 / 共 {total} 行</span>
        <span className="spacer" />
        <button className="btn tiny" disabled={offset <= 0 || loading} onClick={() => setOffset(Math.max(0, offset - limit))}>上一页</button>
        <button className="btn tiny" disabled={loading || offset + shown >= total} onClick={() => setOffset(offset + limit)}>下一页</button>
      </div>
    </Section>
  );
}
