import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AvatarMatch, CategoryNode, ContainerKind, ItemStatus, SourceSite } from "@core/contracts";
import type { CategoryCounts } from "../types";
import { CategoryBars } from "./CategoryBars";
import { CONTAINERS, CONTAINER_LABEL, SITES, SITE_LABEL, STATUSES, STATUS_LABEL, useDebounced } from "./ui";
import { getSearchSuggestions } from "../api";
import {
  activeConditions, activeFilterCount, clearFilters, hasAnyCondition,
  type CategoryLike, type FilterState,
} from "../ui-state";

export { EMPTY_FILTERS } from "../ui-state";
export type { FilterState } from "../ui-state";

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
  categories?: CategoryNode[];
  catCounts?: CategoryCounts | null;
  countsScope?: "filtered" | "global";
  catErr?: string;
  /** 当前参与筛选的头像数量（用于「清空全部」入口的显示） */
  avatarCount: number;
  /** 清空全部：搜索词 + 头像选择 + 全部筛选条件 */
  onClearAll: () => void;
  homeSearchActions?: ReactNode;
  searchSuggestions?: boolean;
}) {
  const f = props.filters;
  const [advOpen, setAdvOpen] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<{ query: string; label: string }[]>([]);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const suggestionTerm = useDebounced(props.text, 180);
  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !document.querySelector('[role="dialog"]:not([hidden])')) {
        event.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
    };
    window.addEventListener("keydown", focus);
    return () => window.removeEventListener("keydown", focus);
  }, []);
  useEffect(() => {
    setSuggestions([]);
    setActiveSuggestion(-1);
    if (!props.searchSuggestions || !focused || !suggestionTerm.trim()) return;
    const request = new AbortController();
    getSearchSuggestions(suggestionTerm, request.signal).then((r) => {
      if (!request.signal.aborted) setSuggestions(r.suggestions);
    }).catch(() => {});
    return () => request.abort();
  }, [focused, suggestionTerm, props.searchSuggestions]);
  const visibleSuggestions = focused && suggestionTerm === props.text ? suggestions : [];
  const selectSuggestion = (query: string) => { props.onText(query); setSuggestions([]); setActiveSuggestion(-1); };
  const set = (patch: Partial<FilterState>) => props.onFilters({ ...f, ...patch });

  const cats = (props.categories ?? []) as CategoryLike[];
  const active = activeConditions(f, cats);
  const advCount = activeFilterCount(f);
  const anyCondition = hasAnyCondition(f, props.text, props.avatarCount);

  return (
    <div className="toolbar">
      <div className="sb-row-main">
        <div className="search-wrap">
          <span className="ico" aria-hidden="true">⌕</span>
          <input
            ref={search}
            type="search"
            placeholder="搜商品名、BOOTH 编号、Avatar 或包内文件"
            aria-label="搜索素材"
            aria-keyshortcuts="Control+k Meta+k"
            aria-controls={visibleSuggestions.length ? "asset-search-suggestions" : undefined}
            aria-activedescendant={activeSuggestion >= 0 && visibleSuggestions[activeSuggestion] ? "asset-search-option-" + activeSuggestion : undefined}
            value={props.text}
            onChange={(e) => props.onText(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || !visibleSuggestions.length) return;
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const length = visibleSuggestions.length;
                setActiveSuggestion((i) => (i < 0 ? (e.key === "ArrowDown" ? 0 : length - 1)
                  : (i + (e.key === "ArrowDown" ? 1 : length - 1)) % length));
              } else if (e.key === "Enter" && visibleSuggestions[activeSuggestion]) {
                e.preventDefault();
                selectSuggestion(visibleSuggestions[activeSuggestion]!.query);
              } else if (e.key === "Escape") { e.preventDefault(); setSuggestions([]); setActiveSuggestion(-1); }
            }}
          />
          {!!visibleSuggestions.length && <div className="search-suggestions" id="asset-search-suggestions" role="listbox" aria-label="搜索补全">
            {visibleSuggestions.map((option, index) => <button id={"asset-search-option-" + index} type="button" role="option"
              aria-selected={index === activeSuggestion} key={option.query} onMouseDown={(e) => e.preventDefault()}
              onClick={() => selectSuggestion(option.query)}>{option.label}</button>)}
          </div>}
        </div>
        <label className="sb-sort" title="排序方式">
          <span className="hint">排序</span>
          <select aria-label="排序方式" value={f.sort} onChange={(e) => set({ sort: e.target.value as FilterState["sort"] })}>
            <option value="relevance">相关度</option>
            <option value="updated">最近更新</option>
            <option value="title">标题</option>
            <option value="size">体积</option>
          </select>
        </label>
      </div>

      {(props.atAvatars.length > 0 || props.unresolved.length > 0) && (
        <div className="chips">
          {props.atAvatars.map((n) => (
            <span className="chip" key={"at-" + n}>@{n}<button onClick={() => props.onRemoveAt(n)} title={"移除 @" + n} aria-label={"移除 @" + n}>×</button></span>
          ))}
          {props.unresolved.map((n) => (
            <span className="chip" key={"un-" + n} style={{ borderColor: "rgba(232,98,79,.5)", background: "rgba(232,98,79,.12)", color: "#ffcdc4" }} title="未匹配到已知头像">
              @{n} 未识别
            </span>
          ))}
        </div>
      )}

      <CategoryBars
        categories={props.categories ?? []}
        counts={props.catCounts ?? null}
        countsScope={props.countsScope ?? "global"}
        catErr={props.catErr}
        top={f.catTop}
        sub={f.catSub}
        loading={props.loading}
        onPick={(top, sub) => set({ catTop: top, catSub: sub })}
        limit={8}
      />

      <div className="sb-cond-row">
        <button
          type="button"
          className={"btn tiny sb-adv" + (advCount > 0 ? " on" : "")}
          aria-expanded={advOpen}
          aria-controls="sb-advanced"
          title={advOpen ? "收起高级筛选" : "展开高级筛选"}
          onClick={() => setAdvOpen((v) => !v)}
        >
          高级筛选{advCount > 0 ? " (" + advCount + ")" : ""} {advOpen ? "▴" : "▾"}
        </button>
        <span className="sb-cond-label">条件：</span>
        <div className="sb-cond-chips" aria-live="polite">
          {active.length === 0
            ? <span className="hint">默认（全部素材）</span>
            : active.map((c) => <span className="cond-chip" key={c.key}>{c.label}</span>)}
        </div>
        <span className="spacer" />
        {active.length > 0 && (
          <button
            type="button"
            className="btn tiny"
            title="只清空筛选条件；搜索词与头像选择保留"
            onClick={() => props.onFilters(clearFilters(f))}
          ><span className="sb-clear-full">清空筛选（保留搜索/头像）</span><span className="sb-clear-short">清空筛选</span></button>
        )}
        {anyCondition && (
          <button
            type="button"
            className="btn tiny danger"
            title="清空搜索词、头像选择和全部筛选条件"
            onClick={props.onClearAll}
          ><span className="sb-clear-full">清空全部（含搜索/头像）</span><span className="sb-clear-short">清空全部</span></button>
        )}
      </div>

      {advOpen && (
        <div className="filters" id="sb-advanced">
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
          <label>收藏
            <label className="chk">
              <input type="checkbox" checked={f.favoriteOnly} onChange={(e) => set({ favoriteOnly: e.target.checked })} />
              只看收藏
            </label>
          </label>
          <label>待确认
            <label className="chk" title="只看有未确认自动分类建议的条目">
              <input type="checkbox" checked={f.pendingCategory} onChange={(e) => set({ pendingCategory: e.target.checked })} />
              只看待确认
            </label>
          </label>
        </div>
      )}

      <div className="sb-count-row">
        <span className="hint">
          {props.loading ? <><span className="spin" /> 查询中…</> : <>命中 <b style={{ color: "var(--fg)" }}>{props.total}</b> 条</>}
        </span>
        {props.homeSearchActions}
        <span className="spacer" />
        <span className="hint" title="分类 chip 上的计数口径">
          {props.countsScope === "filtered" ? "分类计数 = 当前筛选" : "分类计数 = 全局"}
        </span>
      </div>
    </div>
  );
}
