/**
 * EvidenceLine 来源/置信度中文化（真实组件 SSR 渲染）。
 * 断言对象是 apps/web/src/components/ui.tsx 的 EvidenceLine 本身，不是自造 formatter。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { EvidenceLine } from "../../apps/web/src/components/ui";

const strip = (s: string): string => s.replace(/<!-- -->/g, "");
const render = (props: Record<string, unknown>): string => strip(renderToString(createElement(EvidenceLine, props as never)));

describe("EvidenceLine 来源中文化", () => {
  test("auto → 自动识别，不再显示 raw source", () => {
    const h = render({ name: "A", source: "auto", confidence: 0.99 });
    assert.ok(h.includes("自动识别"), h.slice(0, 500));
    assert.ok(!h.includes("source=auto"), "不应再出现 source=auto");
  });
  test("manual → 人工标注，不叫「已确认」", () => {
    const h = render({ name: "A", source: "manual", confidence: 0.99 });
    assert.ok(h.includes("人工标注"), h.slice(0, 500));
    assert.ok(!h.includes("已确认"), "manual 不得显示「已确认」");
  });
  test("confirmed → 用户确认", () => {
    const h = render({ name: "A", source: "confirmed", confidence: 1 });
    assert.ok(h.includes("用户确认"), h.slice(0, 500));
  });
  test("未知 source → 来源未知，且原始值可追溯", () => {
    const h = render({ name: "A", source: "weird", confidence: 0.5 });
    assert.ok(h.includes("来源未知"), h.slice(0, 500));
    assert.ok(h.includes("weird"), "title 应保留原始 source 便于排查");
  });
  test("缺失 source → 来源未知", () => {
    const h = render({ name: "A" });
    assert.ok(h.includes("来源未知"), h.slice(0, 500));
  });
});

describe("EvidenceLine 置信度呈现", () => {
  test("0.99 → 99%，不是 0.99%", () => {
    const h = render({ name: "A", source: "auto", confidence: 0.99 });
    assert.ok(h.includes("99%"), h.slice(0, 500));
    assert.ok(!h.includes("0.99%"), "不得输出 0.99%");
  });
  test("缺失/异常 confidence → 置信度未知，不输出 NaN", () => {
    for (const c of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1, 2]) {
      const h = render({ name: "A", source: "auto", confidence: c });
      assert.ok(h.includes("置信度未知"), String(c) + " → " + h.slice(0, 400));
      assert.ok(!h.includes("NaN"), String(c) + " 不得输出 NaN");
    }
  });
  test("evidence 原文仍按原样渲染（未被中文化改动）", () => {
    const ev = JSON.stringify({ sources: ["archive_path"], evidence: ["archive_path:Assets/x.prefab"] });
    const h = render({ name: "A", source: "auto", confidence: 0.9, evidence: ev });
    assert.ok(h.includes("archive_path"), h.slice(0, 600));
  });
});
