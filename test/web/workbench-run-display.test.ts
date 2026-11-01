/**
 * SSR 展示：计划卡「已执行」不等于验证通过；最近 run 结论 / console error 条数与消息可查看 /
 * GUID 计数与单元计数分开 / sample 不声称全量 / 控制台消息按 React 文本转义。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PlanPanel, RunCard } from "../../apps/web/src/components/AvatarWorkbench";
import type { ImportPlan, ImportRun, PlanLatestRun } from "../../apps/web/src/types";

const strip = (s: string): string => s.replace(/<!-- -->/g, "");

const latest = (over: Partial<PlanLatestRun> = {}): PlanLatestRun => ({
  id: 6, status: "partial_success", startedAt: null, finishedAt: null,
  verification: { scope: "all", checked: 54, expected: 54, found: null, missing: null },
  consoleErrors: ["Broken text PPtr 1", "Broken text PPtr 2", "Broken text PPtr 3"],
  counts: { total: 1, verified: 0, partialSuccess: 1, failed: 0, unknown: 0, cancelled: 0 },
  ...over,
});

const plan = (over: Partial<ImportPlan> = {}): ImportPlan => ({
  id: 14, itemId: 30, state: "executed", avatarId: 1, avatarName: "A", projectPath: "E:/u/P", projectName: "P",
  precheck: { ok: true, status: "ok", warnings: [], errors: [] },
  units: [{ unitId: "70", itemId: 30, assetId: 1, title: "u", packagePath: null, policy: "single_unitypackage", mixed: false, suggested: false, state: "pending", error: null }],
  mixedWarning: null, runId: 6, jobId: null, createdAt: null, error: null,
  risk: { state: "clear", hits: [], scan: { scope: null, truncated: false, files: null, dirs: null } },
  verification: null, latestRun: latest(), ...over,
});

function renderPlan(p: ImportPlan): string {
  return renderToString(createElement(PlanPanel, { plan: p, checks: { "70": true }, onToggle: () => {}, onConfirm: () => {}, busy: false } as never));
}

describe("计划卡：executed 只表示已执行", () => {
  test("executed 文案是「已执行」，不再出现「已完成」", () => {
    const h = strip(renderPlan(plan()));
    assert.ok(h.includes("已执行"), h.slice(0, 400));
    assert.ok(!h.includes("已完成"), "计划状态不再叫「已完成」");
  });

  test("executed + partial run → 计划徽章 warn（不恒绿），并单列最近 run 结论", () => {
    const h = renderPlan(plan());
    assert.ok(h.includes('class="badge warn" title="executed"'), h.slice(0, 500));
    assert.ok(!h.includes('class="badge ok" title="executed"'), "partial 不得显示绿色已执行");
    assert.ok(h.includes("部分成功"), "最近 run 结论必须出现");
    assert.ok(strip(h).includes("run #6"), "点名最近 run");
  });

  test("executed + 无 run → 保守未知（muted，不写验证通过）", () => {
    const h = strip(renderPlan(plan({ latestRun: null, runId: null })));
    assert.ok(h.includes('class="badge muted" title="executed"'), h.slice(0, 500));
    assert.ok(h.includes("验证状态未知"), "无 run 时明确未知");
    assert.ok(!h.includes("验证通过"), "无 run 不得声称通过");
  });

  test("executed + verified run → 绿色 + 验证通过", () => {
    const h = renderPlan(plan({ latestRun: latest({ status: "verified", consoleErrors: [], verification: { scope: "all", checked: 54, expected: 54, found: 54, missing: 0 } }) }));
    assert.ok(h.includes('class="badge ok" title="executed"'), h.slice(0, 500));
    assert.ok(h.includes("验证通过"));
  });

  test("failed / unknown run 各自的 tone 与文案", () => {
    const failed = renderPlan(plan({ latestRun: latest({ status: "failed" }) }));
    assert.ok(failed.includes('class="badge bad" title="executed"'), failed.slice(0, 500));
    const unknown = strip(renderPlan(plan({ latestRun: latest({ status: "unknown" }) })));
    assert.ok(unknown.includes('class="badge warn" title="executed"'), unknown.slice(0, 500));
    assert.ok(unknown.includes("结果未知"));
  });

  test("partial：单元计数与 GUID 计数分开，console error 条数与消息可见（React 文本）", () => {
    const h = strip(renderPlan(plan()));
    assert.ok(h.includes("单元 1"), "单元计数");
    assert.ok(h.includes("部分成功 1"), "单元结论计数");
    assert.ok(h.includes("已查 54/54"), "GUID 计数");
    assert.ok(h.includes("命中 未提供") && h.includes("缺失 未提供"), "summary 缺 found/missing → 未提供");
    assert.ok(h.includes("控制台 error 3 条"), "console error 条数");
    assert.ok(h.includes("Broken text PPtr 1"), "消息可查看");
    assert.ok(!h.includes("<script"), "控制台消息不得注入 HTML");
  });

  test("sample 模式不声称全量", () => {
    const h = strip(renderPlan(plan({ latestRun: latest({ verification: { scope: "sampled", checked: 500, expected: 900, found: null, missing: null } }) })));
    assert.ok(h.includes("抽样校验"), h.slice(0, 600));
    assert.ok(h.includes("不是全量"), "sampled 必须给出限定");
  });
});

describe("执行记录卡：原始状态透传 + 中文结论 + 控制台消息", () => {
  const run = (over: Partial<ImportRun> = {}): ImportRun => ({
    id: 6, planId: 14, state: "partial_success", error: null, startedAt: null, finishedAt: null,
    counts: { total: 1, verified: 0, partialSuccess: 1, failed: 0, unknown: 0, cancelled: 0 },
    verification: { scope: "all", checked: 54, expected: 54, found: null, missing: null },
    consoleErrors: ["e1", "e2", "e3", "e4", "e5", "e6"],
    units: [{
      unitId: "70", itemId: 30, title: "u", state: "partial_success", error: null, startedAt: null, finishedAt: null,
      verification: { scope: "all", checked: 54, expected: 54, found: 54, missing: 0 }, consoleErrors: ["e1", "e2"],
    }],
    ...over,
  });

  test("中文状态徽章（不再固定 busy + 原始英文）", () => {
    const h = strip(renderToString(createElement(RunCard, { run: run() } as never)));
    assert.ok(h.includes('class="badge warn"'), "partial → warn");
    assert.ok(h.includes("部分成功"));
    assert.ok(h.includes("partial_success"), "原始状态仍原样透传");
  });

  test("GUID 覆盖 + 单元计数 + console error 6 条与可展开消息", () => {
    const h = strip(renderToString(createElement(RunCard, { run: run() } as never)));
    assert.ok(h.includes("已查 54/54"));
    assert.ok(h.includes("单元 1"));
    assert.ok(h.includes("控制台 error 6 条"));
    assert.ok(h.includes("<details") || h.includes("点开"), "消息可展开查看");
    assert.ok(h.includes("e6"), "消息文本存在");
  });

  test("verified run → 绿色；unknown → 警告 + 不重试提示", () => {
    const ok = strip(renderToString(createElement(RunCard, { run: run({ state: "verified", consoleErrors: [], verification: { scope: "all", checked: 54, expected: 54, found: 54, missing: 0 } }) } as never)));
    assert.ok(ok.includes('class="badge ok"'), ok.slice(0, 300));
    const unk = strip(renderToString(createElement(RunCard, { run: run({ state: "unknown" }) } as never)));
    assert.ok(unk.includes("结果未知"));
    assert.ok(unk.includes("不要直接重试"));
  });
});
