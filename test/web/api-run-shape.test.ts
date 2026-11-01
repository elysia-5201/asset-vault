/**
 * DTO 映射：兼容后端「嵌套 verification」与「扁平 summary_json / detail_json」两种形状；
 * 计数缺失保持 null（未知），显式 0 保留；plan 的最近 run 必须与 run_id 一致（不拿别的 run 充数）。
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getImportPlan, getImportRun } from "../../apps/web/src/api";

const realFetch = globalThis.fetch;
function serve(payload: unknown): void {
  globalThis.fetch = (async () => new Response(JSON.stringify(payload), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof globalThis.fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

const planPayload = (over: Record<string, unknown> = {}) => ({
  plan: { id: 14, item_id: 30, status: "executed", project_path: "E:/u/P", avatar_id: 1 },
  items: [{ id: 1, plan_id: 14, unit_id: 70, status: "pending" }],
  precheck: { ok: true, status: "ok", warnings: [], errors: [] },
  run_id: 6,
  latestRun: {
    id: 6, status: "partial_success", started_at: "2026-10-31T04:49:34Z", finished_at: "2026-10-31T04:50:02Z",
    summary: { total: 1, verified: 0, partial_success: 1, failed: 0, unknown: 0, cancelled: 0, verificationScope: "all", checked: 54, expected: 54, phase: "done" },
    console_errors: ["Broken text PPtr 1", "Broken text PPtr 2"],
  },
  lastError: null, risks: null, risk_state: null,
  ...over,
});

describe("GET /api/import-plans/:id → plan.latestRun（扁平 summary 形状）", () => {
  test("partial：run 结论与 GUID 计数（found/missing 未提供 → null，不写成 0）", async () => {
    serve(planPayload());
    const plan = await getImportPlan(14);
    assert.equal(plan.state, "executed");
    assert.ok(plan.latestRun, "latestRun 必须映射出来");
    assert.equal(plan.latestRun!.status, "partial_success");
    assert.deepEqual(plan.latestRun!.counts, { total: 1, verified: 0, partialSuccess: 1, failed: 0, unknown: 0, cancelled: 0 });
    assert.deepEqual(plan.latestRun!.verification, { scope: "all", checked: 54, expected: 54, found: null, missing: null });
    assert.equal(plan.latestRun!.consoleErrors!.length, 2);
  });

  test("嵌套 verification（旧形状）仍可解析，且显式 0 保留", async () => {
    serve(planPayload({
      latestRun: {
        id: 6, status: "verified", summary: { verification: { scope: "sampled", checked: 500, expected: 900, found: 500, missing: 0 } },
        console_errors: [],
      },
    }));
    const plan = await getImportPlan(14);
    assert.deepEqual(plan.latestRun!.verification, { scope: "sampled", checked: 500, expected: 900, found: 500, missing: 0 });
    assert.deepEqual(plan.latestRun!.consoleErrors, [], "空数组 = 明确 0 条");
  });

  test("latestRun.id 与 run_id 不一致 → 不绑定（不拿别的 run 充数）", async () => {
    serve(planPayload({ run_id: 9, latestRun: { id: 6, status: "verified", summary: {}, console_errors: null } }));
    const plan = await getImportPlan(14);
    assert.equal(plan.latestRun, null);
    assert.equal(plan.verification, null);
  });
});

describe("GET /api/import-runs/:id → run / unit（扁平 detail_json）", () => {
  const runPayload = () => ({
    run: {
      id: 6, plan_id: 14, status: "partial_success", started_at: "2026-10-31T04:49:34Z", finished_at: "2026-10-31T04:50:02Z",
      console_errors: JSON.stringify(["e1", "e2", "e3", "e4", "e5", "e6"]),
      summary_json: JSON.stringify({ total: 1, verified: 0, partial_success: 1, failed: 0, unknown: 0, cancelled: 0, verificationScope: "all", checked: 54, expected: 54, phase: "done" }),
    },
    items: [{
      id: 1, run_id: 6, plan_item_id: 1, unit_id: 70, status: "partial_success", error: null,
      detail_json: JSON.stringify({ consoleErrors: ["e1", "e2", "e3", "e4", "e5", "e6"], verificationScope: "all", checked: 54, expected: 54, found: 54, missing: 0, missingGuids: [], relPath: "x.unitypackage" }),
    }],
  });

  test("run：单元计数 + GUID 计数分开，缺失数字保持 null", async () => {
    serve(runPayload());
    const run = await getImportRun(6);
    assert.equal(run.state, "partial_success");
    assert.deepEqual(run.counts, { total: 1, verified: 0, partialSuccess: 1, failed: 0, unknown: 0, cancelled: 0 });
    assert.deepEqual(run.verification, { scope: "all", checked: 54, expected: 54, found: null, missing: null });
    assert.equal(run.consoleErrors!.length, 6);
  });

  test("unit：扁平 detail 的 found/missing 如实映射（显式 0 不是未知）", async () => {
    serve(runPayload());
    const run = await getImportRun(6);
    const u = run.units[0]!;
    assert.deepEqual(u.verification, { scope: "all", checked: 54, expected: 54, found: 54, missing: 0 });
    assert.equal(u.consoleErrors!.length, 6);
  });

  test("unit：缺 missing 字段 → null；unknown 分支的嵌套 verification 仍可解析", async () => {
    const p: any = runPayload();
    p.items = [
      { id: 1, run_id: 6, plan_item_id: 1, unit_id: 70, status: "verified", error: null, detail_json: JSON.stringify({ verificationScope: "all", checked: 5, expected: 5, found: 5 }) },
      { id: 2, run_id: 6, plan_item_id: 2, unit_id: 71, status: "unknown", error: "UNKNOWN: x", detail_json: JSON.stringify({ verification: { ok: true, scope: "all", checked: 7, expected: 7, found: 6, missing: 1 } }) },
    ];
    serve(p);
    const run = await getImportRun(6);
    assert.equal(run.units[0]!.verification!.missing, null);
    assert.deepEqual(run.units[1]!.verification, { scope: "all", checked: 7, expected: 7, found: 6, missing: 1 });
    assert.equal(run.units[1]!.consoleErrors, null, "没有 consoleErrors 字段 → null（未知）");
  });
});
