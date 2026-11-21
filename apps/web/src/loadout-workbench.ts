import { describeError, getItem, workbenchItems, type ProjectRow } from "./api";
import type { WorkbenchItem } from "./types";
import { sameSlot } from "./workbench-focus";

type Material = { id: number; title: string };

export interface LoadoutWorkbenchScope {
  id: number;
  name: string;
  avatarId: number;
  items: Material[];
  project?: Pick<ProjectRow, "name" | "path">;
}

export interface LoadoutPackages extends Material {
  units: WorkbenchItem[];
  notice?: string;
  canAnalyze?: boolean;
}

async function loadMaterial(item: Material): Promise<LoadoutPackages> {
  const units: WorkbenchItem[] = [];
  const limit = 500;
  try {
    for (let offset = 0; ; offset += limit) {
      const page = await workbenchItems({ itemId: item.id, limit, offset });
      units.push(...page.items.filter((unit) => unit.itemId === item.id));
      if (page.items.length < limit) break;
    }
    if (units.some((unit) => unit.importable)) return { ...item, units };
    if (units.length) {
      if (units.every((unit) => unit.assetStatus === "missing")) return { ...item, units, notice: "源文件缺失" };
      const unknown = units.some((unit) => unit.policy === "unknown_structure" && unit.assetStatus !== "missing");
      return { ...item, units, notice: unknown ? "包内结构待确认" : "没有可导入的 Unity 包", canAnalyze: unknown };
    }
    const detail = await getItem(item.id);
    if (detail.item.status === "trashed") return { ...item, units, notice: "素材已在回收站" };
    if (!detail.assets.length) return { ...item, units, notice: "未关联本地文件" };
    if (detail.assets.every((asset) => asset.status === "missing")) return { ...item, units, notice: "源文件缺失" };
    return { ...item, units, notice: "待分析包内结构", canAnalyze: true };
  } catch (error) {
    return { ...item, units: [], notice: "读取失败：" + describeError(error) };
  }
}

export async function loadLoadoutPackages(scope: LoadoutWorkbenchScope, isActive: () => boolean): Promise<LoadoutPackages[]> {
  const results: LoadoutPackages[] = [];
  const concurrency = 4;
  for (let i = 0; i < scope.items.length && isActive(); i += concurrency) {
    results.push(...await Promise.all(scope.items.slice(i, i + concurrency).map(loadMaterial)));
  }
  return results;
}

/** 只有唯一且明确适配的普通包才预选，其余交给用户选择。 */
export function defaultLoadoutPackage(row: LoadoutPackages, avatarId: number, allUnits: WorkbenchItem[]): WorkbenchItem | undefined {
  const packageUnits = row.units.filter((unit) => unit.importable
    || unit.policy === "single_unitypackage" || unit.policy === "mixed_unitypackage");
  if (packageUnits.length !== 1) return;
  const unit = packageUnits[0];
  if (!unit.importable || unit.mixed || unit.suggested || unit.policy !== "single_unitypackage") return;
  const matches = unit.avatarMatches?.some((avatar) => avatar.id === avatarId && avatar.level === "confirmed")
    ?? (unit.avatarId === avatarId && unit.level === "confirmed");
  if (matches && !allUnits.some((other) => other.unitId !== unit.unitId && sameSlot(unit, other))) return unit;
}
