/**
 * 搭配清单展示层纯函数（P3-T4；avatar-loadouts spec §7.2/§7.3、§6.2）。
 *
 * 只做文案与形状换算：不发请求、不读 DOM、不改入参。
 * 文案纪律（spec §7.3）：清单状态必须带「手动」限定；证据列叫「工程登记/实际引用/导入校验」，
 * 两者不得互相冒充；证据只读，冲突只提示不自动改写。
 */
import type { LoadoutItem, LoadoutState } from "./types";

export interface LoadoutStateCounts {
  planned: number;
  imported: number;
  verified: number;
}

const STATE_LABEL: Record<LoadoutState, string> = {
  planned: "准备使用",
  imported: "已导入（手动）",
  verified: "已验证（手动）",
};

/** 清单状态 chip 文案（手动声明，不是证据）。 */
export function stateLabel(s: LoadoutState): string {
  return STATE_LABEL[s];
}

/**
 * 整份清单口径的计数文案：stateCounts 含「item 在回收站」的行（spec §6.2），
 * 与 trashedCount、当前列表 total 是三个不同口径，必须分开写。
 */
export function countsCaption(c: { stateCounts: LoadoutStateCounts; trashedCount: number }): string {
  const s = c.stateCounts;
  return [
    stateLabel("planned") + " " + s.planned,
    stateLabel("imported") + " " + s.imported,
    stateLabel("verified") + " " + s.verified,
    "回收站 " + c.trashedCount,
  ].join(" · ") + "（计数含回收站条目）";
}

/** 当前列表 total 口径：受 state / includeTrashedItems 影响，不能拿 stateCounts 冒充。 */
export function listTotalCaption(total: number, opts: { state?: LoadoutState | null; includeTrashed: boolean }): string {
  const scope = opts.state ? stateLabel(opts.state) : "全部状态";
  return "当前列表 " + total + " 条（筛选：" + scope + (opts.includeTrashed ? "；含回收站" : "") + "）";
}

/**
 * reorder 提交形状：可见行在前、隐藏行在后（spec §6.2 形状 1 的通用形式）。
 * 面板只提交可见行时传 hiddenIds=[]，不先加载隐藏行；不改入参。
 */
export function reorderPayload(visibleIds: number[], hiddenIds: number[]): number[] {
  return [...visibleIds, ...hiddenIds];
}

/** 当前可见行的 itemId 顺序（拖拽只在这个集合内换位）。 */
export function visibleReorderIds(items: { itemId: number }[]): number[] {
  return items.map((it) => it.itemId);
}

const EVIDENCE_LABEL = {
  registered: "工程登记",
  referenced: "实际引用",
  verified: "导入校验",
} as const;

/** 证据列文案（只读派生，不是清单状态）。 */
export function evidenceLabel(kind: keyof typeof EVIDENCE_LABEL): string {
  return EVIDENCE_LABEL[kind];
}

/** 证据有无的展示符号；缺失显示「—」，不显示「否/未验证」以免被读成清单状态。 */
export function evidenceMark(present: boolean): string {
  return present ? "✓" : "—";
}

/**
 * 清单声明与工程证据不一致时的提示（spec §7.2）。
 * 只在「声明超出证据」时出现：imported 需要 registered、verified 需要 verified；
 * planned 只是准备使用，没有声明，不构成冲突。提示不改写 state（证据只读）。
 */
export function conflictHint(state: LoadoutState, evidence: LoadoutItem["evidence"]): string {
  const supported = state === "imported" ? evidence.registered : state === "verified" ? evidence.verified : true;
  return supported ? "" : "清单声明与工程证据不一致（不会自动改写）";
}
