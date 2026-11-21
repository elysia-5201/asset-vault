/**
 * 修复轮 1（P2-3）：详情页选包 → 工作台上下文映射（纯函数，无 DOM/网络）。
 * 要求：按现有 assetId / relPath 精确映射；映射不明确时**显式提示、不预选**、不自动执行。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  focusNotice, mapFocusToUnits, unityPackageRelPath, type WorkbenchFocus,
} from "../../apps/web/src/workbench-focus";
import type { WorkbenchItem } from "../../apps/web/src/types";

function unit(p: Partial<WorkbenchItem> & { unitId: string; assetId: number | null; relPath: string | null }): WorkbenchItem {
  return {
    itemId: 7, title: "t", sourceSite: null, sourceItemId: null, shopName: null, coverImageId: null,
    packageName: "pkg.unitypackage", containerPath: null, avatarId: null, avatarName: null, kind: "unitypackage",
    level: "confirmed", evidence: null, policy: "single_unitypackage", mixed: false, importable: true,
    parseState: "ok", suggested: false, confirmed: true, error: null, ...p,
  };
}
const focusOf = (units: { assetId: number; relPath: string }[], title = "条目A"): WorkbenchFocus =>
  ({ itemId: 7, title, assetIds: [...new Set(units.map((u) => u.assetId))], units });

describe("unityPackageRelPath：详情页包 → 单元 relPath", () => {
  test("直接 unitypackage / 压缩包条目 / zip 套 zip", () => {
    assert.equal(unityPackageRelPath({ label: "pkg.unitypackage", entryPath: null, innerEntryPath: null }), "pkg.unitypackage");
    assert.equal(unityPackageRelPath({ label: "inner.unitypackage", entryPath: "a/inner.unitypackage", innerEntryPath: null }), "a/inner.unitypackage");
    assert.equal(unityPackageRelPath({ label: "deep.unitypackage", entryPath: "mid.zip", innerEntryPath: "p/deep.unitypackage" }), "mid.zip::p/deep.unitypackage");
  });
});

describe("mapFocusToUnits：精确映射才预选", () => {
  test("唯一精确命中 → 预选（zip 内 / 嵌套均按 relPath 匹配）", () => {
    const units = [
      unit({ unitId: "1", assetId: 10, relPath: "a/inner.unitypackage", packageName: "inner.unitypackage" }),
      unit({ unitId: "2", assetId: 11, relPath: "mid.zip::p/deep.unitypackage", packageName: "deep.unitypackage" }),
    ];
    const map = mapFocusToUnits(focusOf([
      { assetId: 10, relPath: "a/inner.unitypackage" },
      { assetId: 11, relPath: "mid.zip::p/deep.unitypackage" },
    ]), units);
    assert.deepEqual(map.preselected.sort(), ["1", "2"]);
    assert.deepEqual(map.missingAssetIds, []);
    assert.deepEqual(map.unresolved, []);
  });

  test("relPath 对不上 / 工作台没这个资产 → 不预选并报出来", () => {
    const units = [unit({ unitId: "1", assetId: 10, relPath: "a/other.unitypackage" })];
    const map = mapFocusToUnits(focusOf([
      { assetId: 10, relPath: "a/wanted.unitypackage" },
      { assetId: 99, relPath: "x.unitypackage" },
    ]), units);
    assert.deepEqual(map.preselected, []);
    assert.equal(map.unresolved.length, 1);
    assert.deepEqual(map.missingAssetIds, [99]);
  });

  test("同一归档内的模型包和材质包可一起预选", () => {
    const units = [
      unit({ unitId: "1", assetId: 10, relPath: "a.unitypackage" }),
      unit({ unitId: "2", assetId: 10, relPath: "b.unitypackage" }),
    ];
    const map = mapFocusToUnits(focusOf([
      { assetId: 10, relPath: "a.unitypackage" },
      { assetId: 10, relPath: "b.unitypackage" },
    ]), units);
    assert.deepEqual(map.preselected, ["1", "2"]);
    assert.deepEqual(map.ambiguousAssetIds, []);
  });

  test("不可导入的单元不预选", () => {
    const units = [unit({ unitId: "1", assetId: 10, relPath: "a.unitypackage", importable: false, policy: "unknown_structure" })];
    const map = mapFocusToUnits(focusOf([{ assetId: 10, relPath: "a.unitypackage" }]), units);
    assert.deepEqual(map.preselected, []);
    assert.equal(map.unresolved.length, 1);
  });

  test("存在变体关系的包不预选，即使路径不同", () => {
    const units = [
      unit({ unitId: "1", assetId: 10, relPath: "a.unitypackage", variantIds: ["2"] }),
      unit({ unitId: "2", assetId: 11, relPath: "b.unitypackage" }),
    ];
    const map = mapFocusToUnits(focusOf([
      { assetId: 10, relPath: "a.unitypackage" },
      { assetId: 11, relPath: "b.unitypackage" },
    ]), units);
    assert.deepEqual(map.preselected, []);
    assert.deepEqual(map.ambiguousAssetIds.sort(), [10, 11]);
  });

  test("详情页没勾包（只带条目定位）→ 清单为空、不预选", () => {
    const map = mapFocusToUnits(focusOf([]), [unit({ unitId: "1", assetId: 10, relPath: "a.unitypackage" })]);
    assert.deepEqual(map.preselected, []);
    assert.equal(map.empty, true);
  });
});

describe("focusNotice：提示不误导（不承诺自动导入/执行）", () => {
  test("明确说明带入数量、预选数量与不明确项，并说明仍要人工生成计划", () => {
    const units = [
      unit({ unitId: "1", assetId: 10, relPath: "a.unitypackage", packageName: "alpha.unitypackage" }),
      unit({ unitId: "2", assetId: 11, relPath: "b.unitypackage", packageName: "beta.unitypackage" }),
    ];
    const focus = focusOf([
      { assetId: 10, relPath: "a.unitypackage" },
      { assetId: 11, relPath: "b.unitypackage" },
      { assetId: 99, relPath: "missing.unitypackage" },
    ], "素材X");
    const map = mapFocusToUnits(focus, units);
    const text = focusNotice(focus, map);
    assert.match(text, /素材X/);
    assert.match(text, /3 个包/);
    assert.match(text, /预选 2 个单元/);
    assert.match(text, /1 个包.*未.*对应/, "缺映射必须明说：" + text);
    assert.match(text, /生成计划/, "必须说明仍要人工生成计划/确认/执行");
    assert.ok(!/已自动|自动导入|自动执行/.test(text), "不得暗示自动执行：" + text);
  });

  test("没勾包时给清楚的下一步", () => {
    const focus = focusOf([], "素材Y");
    const text = focusNotice(focus, mapFocusToUnits(focus, []));
    assert.match(text, /素材Y/);
    assert.match(text, /没有勾选/);
    assert.match(text, /生成计划/);
  });
});
