/**
 * 分类导航（隔离预览版）：常用分类常显 + 「更多分类」按需展开。
 * - 一级：前 N 个（默认 8）常显；其余收进弹层；选中项即使不在前 N 也强制常显（不隐藏生效条件）。
 * - 二级：随所选一级渲染，换行展示，不横向截断。
 * - 键盘：Tab + ←/→ 在同类 chip 间移动焦点并选中；弹层支持 Escape 关闭并回焦。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { CategoryNode } from "@core/contracts";
import { UNCATEGORIZED_ID, UNCATEGORIZED_LABEL } from "@core/categories/taxonomy";
import type { CategoryCounts } from "../types";
import { commonCategories, pushEscLayer, dropEscLayer, isTopEscLayer } from "../ui-state";

function chipKeyNav(e: ReactKeyboardEvent<HTMLButtonElement>): void {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const bar = e.currentTarget.parentElement;
  if (!bar) return;
  const chips = Array.from(bar.querySelectorAll<HTMLButtonElement>("button[data-chip]:not([disabled])"));
  const i = chips.indexOf(e.currentTarget);
  if (i < 0) return;
  e.preventDefault();
  const step = e.key === "ArrowRight" ? 1 : -1;
  const next = chips[(i + step + chips.length) % chips.length];
  next.focus();
  next.click();
}

export function CategoryBars(props: {
  categories: CategoryNode[];
  counts: CategoryCounts | null;
  countsScope: "filtered" | "global";
  catErr?: string;
  top: string;
  sub: string;
  loading?: boolean;
  onPick: (top: string, sub: string) => void;
  /** 常用分类常显数量（默认 8） */
  limit?: number;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  /** 弹层用 position:fixed + 实测坐标：分类栏是横向滚动容器（overflow 非 visible），
   *  absolute 定位会被裁切；固定定位同时把面板夹在视口内（窄屏靠右时不出界）。 */
  const [panelPos, setPanelPos] = useState<{ left: number; top: number } | null>(null);
  const moreBtn = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // 展开前先量好位置（useLayoutEffect：避免首帧闪在 (0,0)）。
  useLayoutEffect(() => {
    if (!moreOpen) { setPanelPos(null); return; }
    const b = moreBtn.current?.getBoundingClientRect();
    if (!b) return;
    const w = Math.min(560, Math.max(240, window.innerWidth - 56));
    setPanelPos({ left: Math.max(8, Math.min(b.left, window.innerWidth - w - 8)), top: b.bottom + 6 });
  }, [moreOpen]);

  useEffect(() => {
    if (!moreOpen) return;
    pushEscLayer("cat-more");
    const place = () => {
      const b = moreBtn.current?.getBoundingClientRect();
      if (!b) return;
      const w = Math.min(560, Math.max(240, window.innerWidth - 56));
      setPanelPos({ left: Math.max(8, Math.min(b.left, window.innerWidth - w - 8)), top: b.bottom + 6 });
    };
    place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || moreBtn.current?.contains(t)) return;
      setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 只关最上层：其上有别的弹层时先交给那一层。
      if (!isTopEscLayer("cat-more")) return;
      setMoreOpen(false);
      moreBtn.current?.focus();
      e.stopImmediatePropagation();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      dropEscLayer("cat-more");
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [moreOpen]);

  const tops = (props.categories ?? []).filter((t) => t.enabled || t.id === props.top);
  const hasUncat = tops.some((t) => t.id === UNCATEGORIZED_ID);
  const curTop = tops.find((t) => t.id === props.top) ?? null;
  const kids = (curTop?.children ?? []).filter((c) => c.enabled || c.id === props.sub);
  const scope = props.countsScope === "filtered" ? "当前筛选下" : "全局（/api/categories/counts 不可用）";

  const countOfTop = (id: string, fallback: number): number =>
    props.counts ? (id === UNCATEGORIZED_ID ? props.counts.uncategorized : (props.counts.tops[id] ?? 0)) : fallback;
  const countOfSub = (id: string, fallback: number): number => (props.counts ? (props.counts.subs[id] ?? 0) : fallback);
  const allCount = props.counts ? props.counts.all : null;

  const { common, more } = commonCategories(tops, props.top, props.limit ?? 8);

  const pick = (top: string, sub: string, fromMore = false) => {
    props.onPick(top, sub);
    if (fromMore) {
      setMoreOpen(false);
      moreBtn.current?.focus();
    }
  };

  const chip = (
    key: string, label: string, on: boolean, count: number | null, onClick: () => void, title: string,
  ) => (
    <button
      key={key}
      data-chip=""
      type="button"
      className={"cat-chip" + (on ? " on" : "")}
      aria-pressed={on}
      title={title}
      onClick={onClick}
      onKeyDown={chipKeyNav}
    >
      {label}
      {count !== null && <span className="cat-chip-n">{count}</span>}
    </button>
  );

  return (
    <div className={"cat-bars" + (props.loading ? " busy" : "")}>
      <div className="cat-bar" role="group" aria-label="一级分类">
        <span className="cat-bar-label">分类</span>
        {chip("all", "全部", props.top === "", allCount,
          () => pick("", ""), "清除分类限制（返回全部）")}
        {!hasUncat && chip("uncat", UNCATEGORIZED_LABEL, props.top === UNCATEGORIZED_ID, props.counts ? props.counts.uncategorized : null,
          () => pick(UNCATEGORIZED_ID, ""), "只看未分类（cat_id 为空；与分类树里的系统分类「未分类」是同一集合）")}
        {common.map((t) => chip("top-" + t.id, t.name, props.top === t.id, countOfTop(t.id, t.itemCount),
          () => pick(t.id, ""),
          (t.id === UNCATEGORIZED_ID ? "只看未分类（cat_id 为空）" : "按一级分类筛选（含其下所有子分类）")
            + " · 计数=" + scope + (t.enabled ? "" : " · 该分类已停用")))}

        {more.length > 0 && (
          <span className="cat-more-wrap">
            <button
              ref={moreBtn}
              type="button"
              className={"cat-chip cat-more-btn" + (more.some((c) => c.id === props.top) ? " on" : "")}
              aria-expanded={moreOpen}
              aria-controls="cat-more-panel"
              title={"还有 " + more.length + " 个一级分类，点开查看全部"}
              onClick={() => setMoreOpen((v) => !v)}
            >
              更多分类 <span className="cat-chip-n">{more.length}</span> {moreOpen ? "▴" : "▾"}
            </button>
            {moreOpen && (
              <div
                id="cat-more-panel"
                ref={panelRef}
                role="dialog"
                aria-label="更多分类"
                className="cat-more-panel"
                style={panelPos ? { left: panelPos.left, top: panelPos.top } : undefined}
              >
                <div className="cat-more-head">
                  <span>全部分类（{tops.length + (hasUncat ? 0 : 1)}）</span>
                  <span className="spacer" />
                  <button className="btn tiny ghost" onClick={() => { setMoreOpen(false); moreBtn.current?.focus(); }}>关闭</button>
                </div>
                <div className="cat-more-grid">
                  {tops.map((t) => chip("more-" + t.id, t.name, props.top === t.id, countOfTop(t.id, t.itemCount),
                    () => pick(t.id, "", true),
                    "按一级分类筛选 · 计数=" + scope + (t.enabled ? "" : " · 该分类已停用")))}
                  {!hasUncat && chip("more-uncat", UNCATEGORIZED_LABEL, props.top === UNCATEGORIZED_ID, props.counts ? props.counts.uncategorized : null,
                    () => pick(UNCATEGORIZED_ID, "", true), "只看未分类")}
                </div>
                <div className="hint">常用分类常显；这里只是收起，不会被隐藏生效。</div>
              </div>
            )}
          </span>
        )}
      </div>

      {props.sub !== "" || (curTop && kids.length > 0) ? (
        <div className="cat-bar cat-bar-sub" role="group" aria-label="二级分类">
          <span className="cat-bar-label">{curTop ? curTop.name : "子分类"}</span>
          {chip("sub-all", "全部" + (curTop?.name ?? ""), props.sub === "",
            curTop ? countOfTop(curTop.id, curTop.itemCount) : null,
            () => pick(props.top, ""),
            "不限制二级分类（等于该一级分类的全部）")}
          {kids.map((c) => chip("sub-" + c.id, c.name, props.sub === c.id, countOfSub(c.id, c.itemCount),
            () => pick(props.top, c.id),
            "按二级分类筛选 · 计数=" + scope + (c.enabled ? "" : " · 该分类已停用")))}
        </div>
      ) : null}

      {props.catErr ? <div className="err cat-bar-err">{props.catErr}</div> : null}
      {!props.catErr && props.categories.length === 0 && (
        <div className="hint">分类树还没加载（GET /api/categories）。</div>
      )}
    </div>
  );
}
