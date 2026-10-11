import { useState } from "react";
import type { AvatarMatch, CategoryNode, ContainerKind, ItemStatus, SourceSite } from "@core/contracts";
import type { CategoryStats } from "../types";
import { CONTAINERS, CONTAINER_LABEL, SITES, SITE_LABEL, STATUSES, STATUS_LABEL } from "./ui";

export interface FilterState {
  site: SourceSite | "";
  status: ItemStatus | "";
  container: ContainerKind | "";
  tag: string;
  imported: "any" | "yes" | "no";
  sort: "updated" | "title" | "size";
  /** 物品分类多选（分类树节点 id：clothing / clothing.tops） */
  catIds: string[];
  /** 多选语义：any=命中任一选中节点（默认）；all=条目分类路径必须包含每个选中节点 */
  catMatch: "any" | "all";
  /** 只看未分类（cat_id IS NULL，与分类树里人工选的「其他 › 未分类」不是一回事） */
  uncategorized: boolean;
  /** 只看有待确认的自动分类建议 */
  pendingCategory: boolean;
}

export function SearchBar(props: {
  text: string;
  onText: (s: string) => void;
  filters: FilterState;
  onFilters: (f: FilterState) => void;
  atAvatars: string[];
  unresolved: string[];
  onRemoveAt: (name: string) => void;
  tags: string[];
  loading: boolean;
  total: number;
  /** 分类树（含每个节点的 itemCount）；未加载 / 后端不支持时为空数组 */
  categories?: CategoryNode[];
  catStats?: CategoryStats | null;
  /** 分类接口的显式错误（404 = 后端未提供），非空时在筛选区直接显示，不静默 */
  catErr?: string;
}) {
  const f = props.filters;
  const set = (patch: Partial<FilterState>) => props.onFilters({ ...f, ...patch });
  /** 展开的主分类（纯展示状态，不进筛选） */
  const [open, setOpen] = useState<string[]>([]);
  const catTops = props.categories ?? [];
  const countOf = (id: string): number | null =>
    props.catStats?.counts.find((c) => c.id === id)?.count ?? null;
  const toggleCat = (id: string) =>
    set({ catIds: f.catIds.includes(id) ? f.catIds.filter((x) => x !== id) : [...f.catIds, id] });
  const anyCatFilter = f.catIds.length > 0 || f.uncategorized || f.pendingCategory;

  const chip = (key: string, label: string, on: boolean, onClick: () => void, title?: string, extra?: string) => (
    <button key={key} className={"tag-chip" + (on ? " on" : "")} onClick={onClick} title={title}>
      {label}
      {extra !== undefined && <span className="hint" style={{ marginLeft: "3px" }}>{extra}</span>}
    </button>
  );

  return (
    <div className="toolbar">
      <div className="search-wrap">
        <span className="ico">⌕</span>
        <input
          type="search"
          placeholder="搜索标题/店铺/作者（中日文子串），@头像名 过滤，如：@MANUKA セーラー"
          value={props.text}
          onChange={(e) => props.onText(e.target.value)}
        />
      </div>
      {(props.atAvatars.length > 0 || props.unresolved.length > 0) && (
        <div className="chips">
          {props.atAvatars.map((n) => (
            <span className="chip" key={"at-" + n}>@{n}<button onClick={() => props.onRemoveAt(n)} title="移除">×</button></span>
          ))}
          {props.unresolved.map((n) => (
            <span className="chip" key={"un-" + n} style={{ borderColor: "rgba(232,98,79,.5)", background: "rgba(232,98,79,.12)", color: "#ffcdc4" }} title="未匹配到已知头像">
              @{n} 未识别
            </span>
          ))}
        </div>
      )}
      <div className="filters">
        <label>来源站
          <select value={f.site} onChange={(e) => set({ site: e.target.value as SourceSite | "" })}>
            <option value="">全部</option>
            {SITES.map((s) => <option key={s} value={s}>{SITE_LABEL[s]}</option>)}
          </select>
        </label>
        <label>状态
          <select value={f.status} onChange={(e) => set({ status: e.target.value as ItemStatus | "" })}>
            <option value="">默认（非回收站）</option>
            {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </label>
        <label>容器类型
          <select value={f.container} onChange={(e) => set({ container: e.target.value as ContainerKind | "" })}>
            <option value="">全部</option>
            {CONTAINERS.map((s) => <option key={s} value={s}>{CONTAINER_LABEL[s]}</option>)}
          </select>
        </label>
        <label>标签
          <select value={f.tag} onChange={(e) => set({ tag: e.target.value })}>
            <option value="">全部</option>
            {props.tags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label>已导入
          <select value={f.imported} onChange={(e) => set({ imported: e.target.value as FilterState["imported"] })}>
            <option value="any">全部</option>
            <option value="yes">已导入</option>
            <option value="no">未导入</option>
          </select>
        </label>
        <label>排序
          <select value={f.sort} onChange={(e) => set({ sort: e.target.value as FilterState["sort"] })}>
            <option value="updated">最近更新</option>
            <option value="title">标题</option>
            <option value="size">体积</option>
          </select>
        </label>
      </div>

      {/* ---------- 物品分类筛选（多选，拼进真实 /api/items 查询） ---------- */}
      <div className="cat-filter">
        <div className="row wrap" style={{ gap: "5px", alignItems: "center" }}>
          <span className="hint">分类</span>
          {chip("cat-all", "全部", !anyCatFilter, () => set({ catIds: [], uncategorized: false, pendingCategory: false, catMatch: "any" }),
            "清除分类筛选（仍保留关键词/头像/标签等其它条件）", props.catStats ? props.catStats.total + " 条" : undefined)}
          {chip("cat-uncat", "未分类", f.uncategorized, () => set({ uncategorized: !f.uncategorized }),
            "只看尚未归属任何分类的条目（cat_id IS NULL）", props.catStats ? String(props.catStats.uncategorized) : undefined)}
          {chip("cat-pending", "待确认", f.pendingCategory, () => set({ pendingCategory: !f.pendingCategory }),
            "只看有未确认的自动分类建议的条目", props.catStats ? String(props.catStats.pending) : undefined)}
          <span className="spacer" />
          {f.catIds.length > 1 && (
            <span className="seg" title="多选语义：命中任一选中节点 / 条目分类路径需包含全部选中节点">
              <button className={f.catMatch === "any" ? "on" : ""} onClick={() => set({ catMatch: "any" })}>ANY</button>
              <button className={f.catMatch === "all" ? "on" : ""} onClick={() => set({ catMatch: "all" })}>ALL</button>
            </span>
          )}
          {anyCatFilter && (
            <button className="btn tiny" onClick={() => set({ catIds: [], catMatch: "any", uncategorized: false, pendingCategory: false })}>清除分类筛选</button>
          )}
        </div>

        {props.catErr ? <div className="err" style={{ marginTop: "5px" }}>{props.catErr}</div> : null}

        {!props.catErr && catTops.length === 0 && <div className="hint" style={{ marginTop: "4px" }}>分类树还没加载（GET /api/categories）。</div>}

        {catTops.length > 0 && (
          <div className="cat-tree">
            {catTops.map((t) => {
              const openIt = open.includes(t.id);
              const kids = (t.children ?? []).filter((c) => c.enabled || f.catIds.includes(c.id));
              const hidden = (t.children?.length ?? 0) - kids.length;
              const selKids = (t.children ?? []).filter((c) => f.catIds.includes(c.id)).length;
              const topHidden = !t.enabled && !f.catIds.includes(t.id);
              if (topHidden) return null;
              return (
                <div className="cat-group" key={t.id}>
                  <div className="row wrap" style={{ gap: "4px", alignItems: "center" }}>
                    <button
                      className="btn tiny ghost"
                      onClick={() => setOpen((prev) => (prev.includes(t.id) ? prev.filter((x) => x !== t.id) : [...prev, t.id]))}
                      title={openIt ? "收起子分类" : "展开子分类"}
                    >{openIt ? "▾" : "▸"}</button>
                    {chip("top-" + t.id, t.name, f.catIds.includes(t.id), () => toggleCat(t.id),
                      "按主分类筛选（含其下所有子分类）" + (t.enabled ? "" : "（该分类已停用，仅因已选中而显示）"),
                      countOf(t.id) !== null ? String(countOf(t.id)) : undefined)}
                    {!t.enabled && <span className="hint">已停用</span>}
                    {selKids > 0 && !openIt && <span className="hint">已选 {selKids} 个子分类 ·</span>}
                    {!openIt && kids.length > 0 && (
                      <button className="btn tiny ghost" onClick={() => setOpen((prev) => [...prev, t.id])}>{kids.length} 个子分类 ▸</button>
                    )}
                  </div>
                  {openIt && (
                    <div className="row wrap cat-kids">
                      {kids.length === 0 && <span className="hint">无子分类</span>}
                      {kids.map((c) => (
                        <span className="row" style={{ gap: "2px", alignItems: "center" }} key={c.id}>
                          {chip("sub-" + c.id, c.name, f.catIds.includes(c.id), () => toggleCat(c.id),
                            "子分类" + (c.enabled ? "" : "（已停用，仅因已选中而显示）"),
                            countOf(c.id) !== null ? String(countOf(c.id)) : undefined)}
                          {!c.enabled && <span className="hint">停用</span>}
                        </span>
                      ))}
                      {hidden > 0 && <span className="hint">（已隐藏 {hidden} 个停用分类）</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="row">
        <span className="hint">
          {props.loading ? <><span className="spin" /> 查询中…</> : <>命中 <b style={{ color: "var(--fg)" }}>{props.total}</b> 条</>}
        </span>
        <span className="spacer" />
        <span className="hint">已导入 = 服务端 project_imports（GET /items?imported=1|0）；卡片徽标为本地登记</span>
      </div>
    </div>
  );
}
