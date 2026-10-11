/**
 * 分类体系 v3 §8：中栏「一级分类栏 / 二级分类栏」+ 标签多选 chip 栏。
 *
 * - 一级栏：横向紧凑 chip（深色底 + 中性边框，选中用紫色强调），含「全部」与系统分类「未分类」；
 *   数字是 **当前筛选下**的计数（GET /api/categories/counts；不可用时退回分类树上的全局 itemCount 并标注）。
 * - 二级栏：随所选一级动态渲染，首项「全部<一级名>」；无子分类的一级（如「未分类」）**不占位**。
 * - 键盘：Tab 聚焦 + ←/→ 在同类 chip 间移动焦点并选中（分类栏是单选语义），焦点环见 styles.css 的 :focus-visible。
 */
import { useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { CategoryNode, TagRow } from "@core/contracts";
import { UNCATEGORIZED_ID, UNCATEGORIZED_LABEL } from "@core/categories/taxonomy";
import type { CategoryCounts, TagListRow } from "../types";

/** ←/→ 在同一个 bar 里的 chip 之间移动焦点，并把选择一起带过去（skip 掉的按钮不参与）。 */
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

const fmtCount = (n: number | null | undefined): string => (typeof n === "number" ? String(n) : "");

export function CategoryBars(props: {
  /** 分类树（GET /api/categories）；未加载 / 后端不支持时为空数组 */
  categories: CategoryNode[];
  /** 当前筛选下的计数（GET /api/categories/counts）；null = 该端点不可用，退回全局 itemCount */
  counts: CategoryCounts | null;
  /** counts 的来源，用于给 chip 加 tooltip（filtered=当前筛选 / global=全局） */
  countsScope: "filtered" | "global";
  catErr?: string;
  /** 选中的一级（"" = 全部）；未分类 = UNCATEGORIZED_ID */
  top: string;
  /** 选中的二级（"" = 该一级的全部） */
  sub: string;
  loading?: boolean;
  onPick: (top: string, sub: string) => void;
}) {
  const tops = (props.categories ?? []).filter((t) => t.enabled || t.id === props.top);
  const hasUncat = tops.some((t) => t.id === UNCATEGORIZED_ID);
  const curTop = tops.find((t) => t.id === props.top) ?? null;
  const kids = (curTop?.children ?? []).filter((c) => c.enabled || c.id === props.sub);
  const scope = props.countsScope === "filtered" ? "当前筛选下" : "全局（/api/categories/counts 不可用）";

  const countOfTop = (id: string, fallback: number): number =>
    props.counts ? (id === UNCATEGORIZED_ID ? props.counts.uncategorized : (props.counts.tops[id] ?? 0)) : fallback;
  const countOfSub = (id: string, fallback: number): number => (props.counts ? (props.counts.subs[id] ?? 0) : fallback);
  const allCount = props.counts ? props.counts.all : null;

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
          () => props.onPick("", ""), "清除分类限制（返回全部）")}
        {!hasUncat && chip("uncat", UNCATEGORIZED_LABEL, props.top === UNCATEGORIZED_ID, props.counts ? props.counts.uncategorized : null,
          () => props.onPick(UNCATEGORIZED_ID, ""), "只看未分类（cat_id 为空；与分类树里的系统分类「未分类」是同一集合）")}
        {tops.map((t) => chip("top-" + t.id, t.name, props.top === t.id, countOfTop(t.id, t.itemCount),
          () => props.onPick(t.id, ""),
          (t.id === UNCATEGORIZED_ID
            ? "只看未分类（cat_id 为空）"
            : "按一级分类筛选（含其下所有子分类）")
          + " · 计数=" + scope + (t.enabled ? "" : " · 该分类已停用")))}
      </div>

      {props.sub !== "" || (curTop && kids.length > 0) ? (
        <div className="cat-bar cat-bar-sub" role="group" aria-label="二级分类">
          <span className="cat-bar-label">{curTop ? curTop.name : "子分类"}</span>
          {chip("sub-all", "全部" + (curTop?.name ?? ""), props.sub === "",
            curTop ? countOfTop(curTop.id, curTop.itemCount) : null,
            () => props.onPick(props.top, ""),
            "不限制二级分类（等于该一级分类的全部）")}
          {kids.map((c) => chip("sub-" + c.id, c.name, props.sub === c.id, countOfSub(c.id, c.itemCount),
            () => props.onPick(props.top, c.id),
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

/**
 * 标签多选栏：颜色点 + 多选 + ANY/ALL（v3 §4/§5；旧的单值 tag 下拉仍保留在筛选网格里）。
 *
 * 真实库的标签可能成百上千（BOOTH 话题标签会被一并收进来，实测 596 个），**不能全铺出来**，
 * 否则标签栏会把整个筛选区冲爆。所以：已选中的标签永远显示；其余按使用次数排序，默认只给前 12 个，
 * 剩下的折叠进「更多标签（+N）」——展开后可横向换行 + 竖向滚动，并提供搜索框。
 */
export function TagFilterBar(props: {
  tags: (TagRow | TagListRow)[];
  selected: string[];
  match: "any" | "all";
  onToggle: (name: string) => void;
  onMatch: (m: "any" | "all") => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  if (!props.tags.length) return null;
  const LIMIT = 12;
  const sel = new Set(props.selected);
  const byUse = [...props.tags].sort((a, b) =>
    ((b as TagListRow).itemCount ?? 0) - ((a as TagListRow).itemCount ?? 0) || a.name.localeCompare(b.name));
  const selectedTags = byUse.filter((t) => sel.has(t.name));
  const rest = byUse.filter((t) => !sel.has(t.name));
  const needle = q.trim().toLowerCase();
  const shown = open ? (needle ? rest.filter((t) => t.name.toLowerCase().includes(needle)) : rest) : rest.slice(0, LIMIT);
  const more = rest.length - shown.length;
  const chip = (t: TagRow | TagListRow) => {
    const on = sel.has(t.name);
    const n = (t as TagListRow).itemCount;
    return (
      <button
        key={t.id}
        data-chip=""
        type="button"
        className={"cat-chip tag-cat-chip" + (on ? " on" : "")}
        aria-pressed={on}
        title={"标签「" + t.name + "」" + (t.namespace ? "（namespace=" + t.namespace + "）" : "") + (typeof n === "number" ? " · " + n + " 条" : "")}
        onClick={() => props.onToggle(t.name)}
        onKeyDown={chipKeyNav}
      >
        <span className="tag-dot" style={{ background: t.color ?? "var(--fg-mute)" }} />
        {t.name}
        {typeof n === "number" && <span className="cat-chip-n">{n}</span>}
      </button>
    );
  };
  return (
    <div className="tag-bar">
      <span className="cat-bar-label">标签</span>
      <div className={"cat-bar" + (open ? " tag-open" : "")} role="group" aria-label="标签多选">
        {selectedTags.map(chip)}
        {shown.map(chip)}
        {!open && more > 0 && (
          <button type="button" className="cat-chip tag-more" onClick={() => setOpen(true)}
            title={"还有 " + more + " 个标签未显示（按使用次数排序，点开可搜索）"}>
            更多标签（+{more}）
          </button>
        )}
        {open && needle && shown.length === 0 && <span className="hint">没有匹配「{q}」的标签</span>}
      </div>
      {open && (
        <span className="row" style={{ gap: "6px", marginTop: "6px", alignItems: "center" }}>
          <input className="tag-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={"在 " + rest.length + " 个标签里搜索…"} />
          <button type="button" className="btn tiny" onClick={() => { setOpen(false); setQ(""); }}>收起</button>
        </span>
      )}
      {props.selected.length > 1 && (
        <span className="seg" title="多标签语义：命中任一标签 / 必须同时具有全部标签">
          <button className={props.match === "any" ? "on" : ""} onClick={() => props.onMatch("any")}>ANY</button>
          <button className={props.match === "all" ? "on" : ""} onClick={() => props.onMatch("all")}>ALL</button>
        </span>
      )}
      {props.selected.length > 0 && (
        <button className="btn tiny" onClick={props.onClear}>清除标签（{props.selected.length}）</button>
      )}
    </div>
  );
}
