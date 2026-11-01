/**
 * 展示语义纯函数（新）：计划「已执行」与最近 run 结论分开、GUID 计数与单元计数分开、
 * 缺失数字未知（null）不得当 0、sample 不得声称全量。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  RUN_STATE_LABEL, RUN_STATE_TONE, consoleErrorCauseText, planToneOf, runCountsText, runVerdictOf, verificationText,
} from "../../apps/web/src/run-display";

describe("verificationText：GUID 计数（未知不等于 0）", () => {
  test("全量 + 全部计数 → 保留既有中文口径", () => {
    assert.equal(
      verificationText({ scope: "full", checked: 10, expected: 10, found: 9, missing: 1 }),
      "全量校验：已查 10/10，命中 9，缺失 1",
    );
    assert.equal(
      verificationText({ scope: "all", checked: 54, expected: 54, found: 54, missing: 0 }),
      "全量校验：已查 54/54，命中 54，缺失 0",
    );
  });

  test("后端扁平 summary 只给 checked/expected → found/missing 显示未提供，不写 0", () => {
    const s = verificationText({ scope: "all", checked: 54, expected: 54, found: null, missing: null });
    assert.ok(s.includes("已查 54/54"), s);
    assert.ok(s.includes("命中 未提供") && s.includes("缺失 未提供"), s);
    assert.ok(!s.includes("缺失 0"), "缺数据不能写成 0");
  });

  test("sampled 必须声明只是抽样（不当全量）", () => {
    const s = verificationText({ scope: "sampled", checked: 500, expected: 900, found: 500, missing: null });
    assert.ok(s.includes("抽样校验"), s);
    assert.ok(s.includes("不是全量"), s);
  });

  test("没有 scope 也没有计数 → 空串（不伪造）", () => {
    assert.equal(verificationText(null), "");
    assert.equal(verificationText({ scope: "", checked: null, expected: null, found: null, missing: null }), "");
  });
});

describe("runVerdictOf：run 结论中文与 tone", () => {
  test("verified / partial / failed / unknown 各自标签与 tone", () => {
    assert.deepEqual(
      [runVerdictOf("verified").label, runVerdictOf("verified").tone], ["验证通过", "ok"],
    );
    assert.deepEqual(
      [runVerdictOf("partial_success").key, runVerdictOf("partial_success").tone], ["partial", "warn"],
    );
    assert.ok(runVerdictOf("partial_success").label.includes("部分成功"));
    assert.equal(runVerdictOf("failed").tone, "bad");
    assert.equal(runVerdictOf("unknown").tone, "warn");
    assert.ok(runVerdictOf("unknown").label.includes("结果未知"));
  });

  test("没有 run → 保守未知（不是通过、也不是绿色）", () => {
    assert.equal(runVerdictOf(null).key, "none");
    assert.equal(runVerdictOf(undefined).tone, "muted");
    assert.ok(runVerdictOf("").label.includes("未知"));
  });

  test("在飞状态 → busy，不冒充结论", () => {
    assert.equal(runVerdictOf("running").tone, "busy");
    assert.equal(runVerdictOf("importing").tone, "busy");
  });
});

describe("planToneOf：executed 的 tone 只由最近 run 派生", () => {
  const latest = (status: string) => ({
    id: 6, status, startedAt: null, finishedAt: null, verification: null, consoleErrors: null,
    counts: { total: 1, verified: 0, partialSuccess: 1, failed: 0, unknown: 0, cancelled: 0 },
  });
  test("executed 不再恒绿：verified 绿、partial/failed/unknown 各自 tone", () => {
    assert.equal(planToneOf({ state: "executed", latestRun: latest("verified") }), "ok");
    assert.equal(planToneOf({ state: "executed", latestRun: latest("partial_success") }), "warn");
    assert.equal(planToneOf({ state: "executed", latestRun: latest("failed") }), "bad");
    assert.equal(planToneOf({ state: "executed", latestRun: latest("unknown") }), "warn");
  });

  test("executed 但没有 run → muted（未知不绿色）", () => {
    assert.equal(planToneOf({ state: "executed", latestRun: null }), "muted");
  });

  test("非 executed 保持原映射", () => {
    assert.equal(planToneOf({ state: "ready", latestRun: null }), "warn");
    assert.equal(planToneOf({ state: "failed", latestRun: null }), "bad");
  });
});

describe("计数与原因文案", () => {
  test("单元计数单独成句（不与 GUID 混）", () => {
    const s = runCountsText({ total: 1, verified: 0, partialSuccess: 1, failed: 0, unknown: 0, cancelled: 0 });
    assert.ok(s.includes("单元 1"), s);
    assert.ok(s.includes("已校验 0") && s.includes("部分成功 1"), s);
    assert.ok(!s.includes("GUID"), "单元数行不写 GUID");
    assert.equal(runCountsText(null), "");
  });

  test("console error 条数 + 缺失数（1 条与 0 条都如实）", () => {
    assert.ok(consoleErrorCauseText(["a", "b"], 0).includes("控制台 error 2 条"));
    assert.ok(consoleErrorCauseText([], 0).includes("控制台 error 0 条"));
    assert.ok(consoleErrorCauseText(null, null).includes("控制台未提供"), "没读到不能写成 0 条");
  });
});
