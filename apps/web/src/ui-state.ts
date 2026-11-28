/**
 * 纯 UI 状态逻辑（筛选条件摘要/重置/分类收敛）。
 * 与 React 无关，便于用 node:test 直接做 RED→GREEN；不依赖后端与真实数据。
 */
import type { ContainerKind, ItemStatus, SourceSite } from "@core/contracts";

export interface FilterState {
  site: SourceSite | "";
  status: ItemStatus | "";
  container: ContainerKind | "";

  imported: "any" | "yes" | "no";
  sort: "relevance" | "updated" | "title" | "size";
  catTop: string;
  catSub: string;
  pendingCategory: boolean;
  favoriteOnly: boolean;
}

export const EMPTY_FILTERS: FilterState = {
  site: "", status: "", container: "", imported: "any", sort: "relevance",
  catTop: "", catSub: "", pendingCategory: false, favoriteOnly: false,
};

// 与 components/ui.tsx 的展示标签保持一致（隔离副本，故意只复制这三张映射表，
// 避免把 React 模块拉进纯逻辑测试）。
const SITE_LABEL: Record<SourceSite, string> = {
  booth: "BOOTH", gumroad: "Gumroad", unity_asset_store: "Unity Asset Store", itch: "itch.io", other: "其它", local: "本地",
};
const STATUS_LABEL: Record<ItemStatus, string> = { inbox: "待整理", active: "在库", archived: "归档", trashed: "回收站" };
const CONTAINER_LABEL: Record<ContainerKind, string> = { zip: "zip", "7z": "7z", rar: "rar", unitypackage: "unitypackage", dir: "目录", file: "单文件" };
const IMPORTED_LABEL: Record<"yes" | "no", string> = { yes: "已导入", no: "未导入" };

export interface CategoryLike { id: string; name: string; children?: CategoryLike[] }
export interface ActiveCondition { key: string; label: string }

function findCategory(cats: CategoryLike[], id: string): CategoryLike | null {
  for (const t of cats) {
    if (t.id === id) return t;
    const sub = (t.children ?? []).find((c) => c.id === id);
    if (sub) return sub;
  }
  return null;
}

/** 高级筛选面板里的条件（分类栏是常显的，由分类 chip 自身反馈，不计入此数）。 */
export function activeFilterCount(f: FilterState): number {
  let n = 0;
  if (f.site) n++;
  if (f.status) n++;
  if (f.container) n++;
  if (f.imported !== "any") n++;
  if (f.pendingCategory) n++;
  if (f.favoriteOnly) n++;
  return n;
}

/** 活动条件摘要（顺序固定；未知分类 id 原样显示，绝不静默丢弃）。 */
export function activeConditions(f: FilterState, cats: CategoryLike[]): ActiveCondition[] {
  const out: ActiveCondition[] = [];
  if (f.site) out.push({ key: "site", label: "来源：" + SITE_LABEL[f.site] });
  if (f.status) out.push({ key: "status", label: "状态：" + STATUS_LABEL[f.status] });
  if (f.container) out.push({ key: "container", label: "容器：" + CONTAINER_LABEL[f.container] });
  if (f.imported !== "any") out.push({ key: "imported", label: "已导入：" + IMPORTED_LABEL[f.imported] });
  if (f.pendingCategory) out.push({ key: "pendingCategory", label: "待确认" });
  if (f.favoriteOnly) out.push({ key: "favoriteOnly", label: "只看收藏" });
  if (f.catTop) {
    const top = findCategory(cats, f.catTop);
    const sub = f.catSub ? findCategory(cats, f.catSub) : null;
    const name = top?.name ?? f.catTop;
    out.push({ key: "category", label: "分类：" + name + (f.catSub ? " / " + (sub?.name ?? f.catSub) : "") });
  }
  return out;
}

/** 清空筛选条件：保留排序偏好；搜索词与头像选择在 App 状态里，二者不受影响。 */
export function clearFilters(f: FilterState): FilterState {
  return { ...EMPTY_FILTERS, sort: f.sort };
}

/** 是否存在任何条件（含搜索词与头像选择），用于「清空全部」入口。 */
export function hasAnyCondition(f: FilterState, text: string, avatarCount: number): boolean {
  return activeConditions(f, []).length > 0 || text.trim() !== "" || avatarCount > 0;
}

/**
 * 常用分类收敛：默认展示前 limit 个；若当前选中项不在其中，用选中项替换最后一个，
 * 保证选中态永远可见（隐藏条件必须可见、有反馈）。
 */
export function commonCategories<T extends CategoryLike>(
  cats: T[], selectedId: string, limit = 8,
): { common: T[]; more: T[] } {
  const base = cats.slice(0, Math.max(0, limit));
  const sel = selectedId ? cats.find((c) => c.id === selectedId) ?? null : null;
  const common = sel && !base.some((c) => c.id === sel.id)
    ? [...base.slice(0, Math.max(0, limit - 1)), sel]
    : base;
  const ids = new Set(common.map((c) => c.id));
  return { common, more: cats.filter((c) => !ids.has(c.id)) };
}

/**
 * Esc 分层：document 上的多个 Escape 监听无法靠 stopPropagation 互相隔离
 * （同一节点上的监听不存在冒泡先后），因此用一个显式「最上层」登记表：
 * 每个弹层打开时 push、关闭/清理时 drop，Esc 处理器只在自己是栈顶时动作，
 * 动作后 stopImmediatePropagation 阻止同节点其它处理器再看到这次按键。
 */
const escLayerStack: string[] = [];

/** 打开（或重新打开）一层：已在栈里则移到栈顶，保证「后打开的在上」。 */
export function pushEscLayer(id: string): void {
  const i = escLayerStack.indexOf(id);
  if (i >= 0) escLayerStack.splice(i, 1);
  escLayerStack.push(id);
}

/** 关闭一层；未登记时无操作。 */
export function dropEscLayer(id: string): void {
  const i = escLayerStack.indexOf(id);
  if (i >= 0) escLayerStack.splice(i, 1);
}

/** 该层是否为当前最上层（只有最上层响应 Escape）。 */
export function isTopEscLayer(id: string): boolean {
  return escLayerStack.length > 0 && escLayerStack[escLayerStack.length - 1] === id;
}

/** 清空（仅测试用）。 */
export function resetEscLayers(): void {
  escLayerStack.length = 0;
}
