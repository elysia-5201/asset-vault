/**
 * 详情页「选包」→ 头像工作台「单元」的上下文映射（纯函数：无 DOM / 网络 / React，可单测）。
 *
 * 背景（task-1 修复轮 1）：详情页的包列表与工作台的单元列表不是同一份数据 ——
 * 包来自 listUnityPackageCandidates（assetId + entryPath/innerEntryPath），
 * 单元来自 asset_units（assetId + rel_path）。二者能**精确**对上：
 * - 直接 .unitypackage：relPath = 文件名（= 包的 label）
 * - 压缩包里的包：relPath = entryPath
 * - zip 套 zip：relPath = "entryPath::innerEntryPath"
 * 对不上（还没做结构分析、包被改名）或存在互斥变体时，
 * **不预选**，由 focusNotice 显式说明；绝不自动生成/执行计划。
 */
import type { WorkbenchItem } from "./types";

/** 详情页勾选的一个包 → 期望的工作台单元定位。 */
export interface FocusUnitRef { assetId: number; relPath: string }

/** 从详情页打开工作台时带的上下文（itemId 用于把单元列表定位到该条目）。 */
export interface WorkbenchFocus {
  itemId: number;
  title?: string;
  /** 去重后的资产 id（仅用于展示/排障，映射以 units 为准） */
  assetIds: number[];
  /** 详情页勾选的包（assetId + 期望 relPath）；空数组 = 只定位条目、不预选 */
  units: FocusUnitRef[];
}

export interface FocusMap {
  /** 可安全预选的单元 id（精确对应、可导入、无歧义/互斥冲突） */
  preselected: string[];
  /** 精确对应到的单元 id（含因歧义未预选的） */
  matched: string[];
  /** 资产有单元但 relPath 对不上，或对应单元不可导入 */
  unresolved: (FocusUnitRef & { reason: "relpath-mismatch" | "not-importable" })[];
  /** 互斥变体或重复路径涉及的资产 */
  ambiguousAssetIds: number[];
  /** 工作台里完全没有这个资产的可导入单元（可能还没做结构分析） */
  missingAssetIds: number[];
  /** 详情页没有勾选任何包 */
  empty: boolean;
}

/** 详情页的包 → 单元 relPath（与 apps/server/src/services/structure.ts 的单元 rel_path 构造一致）。 */
export function unityPackageRelPath(p: { label: string; entryPath: string | null; innerEntryPath: string | null }): string {
  const label = String(p.label ?? "");
  const entry = p.entryPath ? String(p.entryPath) : "";
  const inner = p.innerEntryPath ? String(p.innerEntryPath) : "";
  if (!entry) return label;
  return inner ? entry + "::" + inner : entry;
}

/** 同一个归档可以包含多个独立包。只拦互斥变体或重复包路径。 */
export function sameSlot(a: WorkbenchItem, b: WorkbenchItem): boolean {
  if (a.unitId === b.unitId) return true;
  if (a.variantIds?.includes(b.unitId) || b.variantIds?.includes(a.unitId)) return true;
  const first = a.relPath || a.packageName;
  const second = b.relPath || b.packageName;
  return a.itemId === b.itemId && !!first && !!second &&
    first.replaceAll("\\", "/").toLowerCase() === second.replaceAll("\\", "/").toLowerCase();
}

/**
 * 把详情页上下文映射到工作台单元。
 * 只有「唯一、可导入、且与其它预选项不互斥」的单元才进入 preselected。
 */
export function mapFocusToUnits(focus: WorkbenchFocus | null | undefined, units: WorkbenchItem[]): FocusMap {
  const map: FocusMap = { preselected: [], matched: [], unresolved: [], ambiguousAssetIds: [], missingAssetIds: [], empty: true };
  if (!focus || !focus.units.length) return map;
  map.empty = false;
  const assetsWithUnits = new Set<number>();
  for (const u of units) if (u.assetId !== null) assetsWithUnits.add(u.assetId);

  const exact: WorkbenchItem[] = [];
  const pushUnique = (u: WorkbenchItem) => { if (!exact.some((x) => x.unitId === u.unitId)) exact.push(u); };
  for (const ref of focus.units) {
    if (!assetsWithUnits.has(ref.assetId)) {
      if (!map.missingAssetIds.includes(ref.assetId)) map.missingAssetIds.push(ref.assetId);
      continue;
    }
    const hits = units.filter((u) => u.assetId === ref.assetId && String(u.relPath ?? "") === ref.relPath);
    if (!hits.length) { map.unresolved.push({ ...ref, reason: "relpath-mismatch" }); continue; }
    const importable = hits.filter((u) => u.importable);
    if (!importable.length) { map.unresolved.push({ ...ref, reason: "not-importable" }); continue; }
    for (const u of importable) pushUnique(u);
  }
  map.matched = exact.map((u) => u.unitId);

  const conflict = new Set<string>();
  for (let i = 0; i < exact.length; i++) {
    for (let j = i + 1; j < exact.length; j++) {
      if (!sameSlot(exact[i], exact[j])) continue;
      for (const unit of [exact[i], exact[j]]) {
        conflict.add(unit.unitId);
        if (unit.assetId !== null && !map.ambiguousAssetIds.includes(unit.assetId)) map.ambiguousAssetIds.push(unit.assetId);
      }
    }
  }
  map.preselected = exact.filter((u) => !conflict.has(u.unitId)).map((u) => u.unitId);
  return map;
}

/**
 * 同一个 focus 只带入一次，但"工作台还没有这个条目的单元"不算带入完成：
 * 用户按提示扫描出单元后要能再精确预选一次（修复轮 2 N1）。
 * 一旦带入过（appliedKey 命中）就不再置位 —— reload / 再次扫描不得覆盖用户手动选择、也不反复 toggle。
 */
export function focusApplyAllowed(
  focus: WorkbenchFocus | null | undefined,
  units: WorkbenchItem[],
  appliedKey: string,
): boolean {
  if (!focus || !focus.itemId) return false;
  if (appliedKey === "focus:" + focus.itemId) return false;
  return units.length > 0;
}

/**
 * 人读提示：说明带入/预选/未对应各多少，并明确「仍要人工生成计划 → 看风险 → 确认 → 执行」。
 * 不承诺自动导入/自动执行（避免"已选 N"式的误导）。
 */
export function focusNotice(focus: WorkbenchFocus, map: FocusMap): string {
  const title = focus.title && focus.title.trim() ? "「" + focus.title.trim() + "」" : "条目 #" + focus.itemId;
  const next = "请核对导入清单 → 生成计划 → 看风险 → 确认 → 执行（不会自动生成或执行计划）。";
  if (map.empty) return "已定位到" + title + "的素材单元：详情页没有勾选任何包，" + next;
  const head = "已从" + title + "带入 " + focus.units.length + " 个包，预选 "
    + map.preselected.length + " 个单元（按 assetId + relPath 精确对应）";
  const notes: string[] = [];
  if (map.missingAssetIds.length) notes.push(map.missingAssetIds.length + " 个包在工作台里未找到对应单元（可能还没做结构分析）");
  if (map.unresolved.length) notes.push(map.unresolved.length + " 个包的 relPath 未精确对应到可导入单元（可能还没做结构分析或包被改名）");
  if (map.ambiguousAssetIds.length) notes.push(map.ambiguousAssetIds.length + " 个资产存在互斥变体或重复路径，未预选");
  return head + "。" + (notes.length ? notes.join("；") + "，这些未预选。" : "") + next;
}
