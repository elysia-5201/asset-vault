import type { AvatarMatch, CategoryNode, ContainerKind, ItemStatus, SourceSite } from "@core/contracts";
import type { CategoryCounts } from "../types";
import { CategoryBars } from "./CategoryBars";
import { CONTAINERS, CONTAINER_LABEL, SITES, SITE_LABEL, STATUSES, STATUS_LABEL } from "./ui";

export interface FilterState {
  site: SourceSite | "";
  status: ItemStatus | "";
  container: ContainerKind | "";

  imported: "any" | "yes" | "no";
  sort: "updated" | "title" | "size";
  /** 一级分类（"" = 全部；UNCATEGORIZED_ID = 未分类系统分类） */
  catTop: string;
  /** 二级分类（"" = 该一级分类的全部） */
  catSub: string;
  /** 只看有待确认的自动分类建议 */
  pendingCategory: boolean;

  /** 只看收藏 */
  favoriteOnly: boolean;
}

export const EMPTY_FILTERS: FilterState = {
  site: "", status: "", container: "", imported: "any", sort: "updated",
  catTop: "", catSub: "", pendingCategory: false, favoriteOnly: false,
};

export function SearchBar(props: {
  text: string;
  onText: (s: string) => void;
  filters: FilterState;
  onFilters: (f: FilterState) => void;
  atAvatars: string[];
  unresolved: string[];
  onRemoveAt: (name: string) => void;
  loading: boolean;
  total: number;
  /** 分类树（含每个节点的全局 itemCount）；未加载 / 后端不支持时为空数组 */
  categories?: CategoryNode[];
  /** **当前筛选下**的分类计数（GET /api/categories/counts）；null = 不可用 */
  catCounts?: CategoryCounts | null;
  /** 计数来源：filtered=当前筛选 / global=退回树上的全局计数 */
  countsScope?: "filtered" | "global";
  /** 分类接口的显式错误（404 = 后端未提供），非空时在筛选区直接显示，不静默 */
  catErr?: string;
}) {
  const f = props.filters;
  const set = (patch: Partial<FilterState>) => props.onFilters({ ...f, ...patch });
  const catActive = f.catTop !== "" || f.pendingCategory;

  return (
    <div className="toolbar">
      <div className="search-wrap">
        <span className="ico">⌕</span>
        <input
          type="search"
          placeholder="搜索标题/店铺/作者/标签（中日文子串），@头像名 过滤，如：@MANUKA 哥特风"
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

      {/* ---------- 一级 / 二级分类栏（v3 §8：横向紧凑 chip + 当前筛选下的计数） ---------- */}
      <CategoryBars
        categories={props.categories ?? []}
        counts={props.catCounts ?? null}
        countsScope={props.countsScope ?? "global"}
        catErr={props.catErr}
        top={f.catTop}
        sub={f.catSub}
        loading={props.loading}
        onPick={(top, sub) => set({ catTop: top, catSub: sub })}
      />
      <div className="row wrap" style={{ gap: "5px", alignItems: "center" }}>
        <button
          className={"cat-chip" + (f.pendingCategory ? " on" : "")}
          data-chip=""
          aria-pressed={f.pendingCategory}
          title="只看有未确认自动分类建议的条目"
          onClick={() => set({ pendingCategory: !f.pendingCategory })}
        >待确认</button>
        {catActive && (
          <button className="btn tiny" onClick={() => set({ catTop: "", catSub: "", pendingCategory: false })}>清除分类筛选</button>
        )}
        <span className="spacer" />
        <span className="hint">
          {props.countsScope === "filtered"
            ? "计数 = 当前筛选下（GET /api/categories/counts）"
            : "计数退回分类树的全局 itemCount（GET /api/categories/counts 不可用）"}
        </span>
      </div>

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
        <label className="chk-cell">收藏
          <label className="chk">
            <input type="checkbox" checked={f.favoriteOnly} onChange={(e) => set({ favoriteOnly: e.target.checked })} />
            只看收藏
          </label>
        </label>
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
