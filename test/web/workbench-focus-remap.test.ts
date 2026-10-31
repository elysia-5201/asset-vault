/**
 * 修复轮 2（N1 + P3）：focus 带入在"条目还没有单元"时不锁死，扫描补齐后要能再精确预选一次；
 * 但已有单元时只带入一次，之后 reload / 扫描不得覆盖用户手动选择或反复 toggle。
 * 同时 P3：focus 视图（avatarId 通常为 null）刷新按钮必须可用。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { focusApplyAllowed, type WorkbenchFocus } from "../../apps/web/src/workbench-focus";
import type { WorkbenchItem } from "../../apps/web/src/types";

const focus: WorkbenchFocus = { itemId: 7, title: "条目A", assetIds: [10], units: [{ assetId: 10, relPath: "a.unitypackage" }] };

function unit(unitId: string, assetId: number, relPath: string): WorkbenchItem {
  return {
    unitId, itemId: 7, title: "t", sourceSite: null, sourceItemId: null, shopName: null, coverImageId: null,
    assetId, relPath, packageName: "a.unitypackage", containerPath: null, avatarId: null, avatarName: null,
    kind: "unitypackage", level: "confirmed", evidence: null, policy: "single_unitypackage", mixed: false,
    importable: true, parseState: "ok", suggested: false, confirmed: true, error: null,
  };
}
const key = "focus:7";

describe("focusApplyAllowed：未分析条目扫描后仍可带入一次", () => {
  test("还没有单元 → 不置位（提示停在待补齐，扫描完成加载 units 后可再映射）", () => {
    assert.equal(focusApplyAllowed(focus, [], ""), false);
  });

  test("扫描补齐单元后 → 允许再一次精确预选；置位后不再反复 toggle（不覆盖手动选择）", () => {
    const units = [unit("1", 10, "a.unitypackage")];
    assert.equal(focusApplyAllowed(focus, units, ""), true);
    assert.equal(focusApplyAllowed(focus, units, key), false, "同一 focus 只带入一次");
    assert.equal(focusApplyAllowed(focus, [], key), false, "已带入过，即便列表暂时为空也不重置");
  });

  test("没有 focus / 不同条目 → 不误触发", () => {
    assert.equal(focusApplyAllowed(null, [unit("1", 10, "a.unitypackage")], ""), false);
    assert.equal(focusApplyAllowed({ ...focus, itemId: 8 }, [unit("1", 10, "a.unitypackage")], key), true, "换了条目应重新带入");
  });
});

describe("AvatarWorkbench 源码级防回退（N1 + 刷新按钮）", () => {
  const src = () => readFileSync(fileURLToPath(new URL("../../apps/web/src/components/AvatarWorkbench.tsx", import.meta.url)), "utf8");

  test("映射逻辑走纯函数：无单元时不置位 focusAppliedRef，有单元才置位", () => {
    const s = src();
    assert.ok(s.includes("focusApplyAllowed"), "必须复用可单测的纯函数");
    assert.ok(s.includes('from "../workbench-focus"'), "必须从纯函数模块导入（不内联映射逻辑）");
    assert.ok(s.includes("if (!focusApplyAllowed(focus, items, focusAppliedRef.current)) return;"), "无单元/已带入都不得置位");
    assert.match(s, /focusAppliedRef.current = key;/, "只有成功带入后才置位（避免每次 reload 覆盖手动选择）");
  });

  test("focus 视图下刷新按钮不再被 avatarId === null 禁用", () => {
    const s = src();
    assert.ok(!/disabled=\{avatarId === null\}/.test(s), "focus 模式 avatarId 通常为 null，按钮不能再因此禁用");
    assert.match(s, /disabled=\{avatarId === null && !\(focusOnly && focus\)\}/, "只在非 focus 且没选 Avatar 时才禁用");
  });
});
