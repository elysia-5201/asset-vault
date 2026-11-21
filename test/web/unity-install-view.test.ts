/**
 * Unity 一键安装：view/handler helper（T4；brief task-4-brief.md:38-49）。
 *
 * 证据层级：
 * ① 纯 helper：标签/门控/请求体（字面量断言，独立于实现）；
 * ② 真实 handler 工厂：注入 deps 执行真实函数体，断言「取消 0 apply / replace 未确认不 apply /
 *    失败不假成功 / probe 与 rollback 各自请求 / operationId 来自真实返回」；
 * ③ 不声称 DOM：SettingsPanel 的 JSX 接线在 unity-install-settings.test.ts 做静态补充。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createUnityInstallHandlers, installApplyBody, installCanApply, installCancelRequest, installChangeLabel,
  installPreviewRequest, installProbeRequest, installRollbackRequest, installStatusRequest, installStepLabel,
  type UnityInstallHandlerDeps,
} from "../../apps/web/src/unity-install-view";
import type {
  UnityInstallApplyResult, UnityInstallOperation, UnityInstallPreview, UnityInstallProbe, UnityInstallStatus,
} from "../../apps/web/src/types";

function preview(over: Partial<UnityInstallPreview> = {}): UnityInstallPreview {
  return {
    previewId: "p1",
    expiresAt: "2026-11-05T10:10:00.000Z",
    project: {
      path: "E:\\My Project", pathNorm: "e:/my project", name: "My Project", unityVersion: "2022.3.10f1",
      manifestPath: "E:\\My Project\\Packages\\manifest.json", manifestHash: "h0",
      projectVersionPath: "E:\\My Project\\ProjectSettings\\ProjectVersion.txt",
    },
    package: {
      id: "com.coplaydev.unity-mcp", targetVersion: "10.0.0",
      targetUrl: "https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#v10.0.0",
      current: null, change: "add",
    },
    diff: "+ com.coplaydev.unity-mcp",
    backup: { dir: "E:\\data\\unity-install\\backups\\op1", files: [] },
    prerequisites: [{ id: "unity_version", status: "ok", detail: "2022.3.10f1" }],
    warnings: [],
    previewHash: "ph1",
    ...over,
  };
}

function applyResult(over: Partial<UnityInstallApplyResult> = {}): UnityInstallApplyResult {
  return { operationId: "op1", status: "config_applied", manifestHash: "h1", backupDir: "E:\\b\\op1", warnings: [], ...over };
}

function operation(over: Partial<UnityInstallOperation> = {}): UnityInstallOperation {
  return {
    operationId: "op1", projectPath: "E:\\My Project", projectPathNorm: "e:/my project",
    packageId: "com.coplaydev.unity-mcp", targetVersion: "10.0.0", targetUrl: "u", status: "config_applied",
    createdAt: "2026-11-05T10:00:00.000Z", updatedAt: "2026-11-05T10:00:01.000Z",
    beforeHash: "h0", afterHash: "h1", plannedAfterHash: "h1", backupDir: "E:\\b\\op1",
    steps: { config: "done", upm: "unknown", compile: "unknown", bridge: "unknown", tool: "unknown", server: "unknown" },
    ...over,
  };
}

function status(over: Partial<UnityInstallStatus> = {}): UnityInstallStatus {
  return {
    projectPath: "E:\\My Project", projectName: "My Project", unityVersion: "2022.3.10f1",
    packageId: "com.coplaydev.unity-mcp", targetVersion: "10.0.0", config: "applied",
    upm: "pending", compile: "unknown", bridge: "unknown", tool: "unknown", server: "unknown", warnings: [], ...over,
  };
}

function probe(over: Partial<UnityInstallProbe> = {}): UnityInstallProbe {
  return {
    projectPath: "E:\\My Project", editor: null, projectMatch: false, compile: "unknown",
    bridge: "editor_not_open", tool: "unknown", server: "unknown", warnings: [], ...over,
  };
}

// ---------------- ① 纯 helper ----------------

test("change/step 文案固定；未知 step 原样返回不伪造成功", () => {
  assert.equal(installChangeLabel("add"), "新增");
  assert.equal(installChangeLabel("replace"), "替换");
  assert.equal(installChangeLabel("none"), "已安装");
  assert.equal(installChangeLabel("conflict"), "冲突");
  assert.equal(installStepLabel("config"), "配置");
  assert.equal(installStepLabel("upm"), "UPM 解析");
  assert.equal(installStepLabel("compile"), "编译");
  assert.equal(installStepLabel("bridge"), "桥接");
  assert.equal(installStepLabel("tool"), "工具");
  assert.equal(installStepLabel("server"), "服务");
  assert.equal(installStepLabel("weird"), "weird");
});

test("apply 门控：null/冲突/替换未确认都不可 apply", () => {
  assert.equal(installCanApply(null, false), false);
  assert.equal(installCanApply(preview({ package: { ...preview().package, change: "replace" } }), false), false);
  assert.equal(installCanApply(preview({ package: { ...preview().package, change: "replace" } }), true), true);
  assert.equal(installCanApply(preview({ package: { ...preview().package, change: "conflict" } }), true), false);
  assert.equal(installCanApply(preview({ package: { ...preview().package, change: "add" } }), false), true);
  assert.equal(installCanApply(preview({ package: { ...preview().package, change: "none" } }), false), true);
});

test("请求体：apply 只含 previewId/confirm/confirmReplace；其余各自形状", () => {
  assert.deepEqual(installApplyBody("p1", false), { previewId: "p1", confirm: true, confirmReplace: false });
  assert.deepEqual(installApplyBody("p1", true), { previewId: "p1", confirm: true, confirmReplace: true });
  assert.deepEqual(installPreviewRequest("E:\\My Project"), { projectPath: "E:\\My Project" });
  assert.deepEqual(installStatusRequest("E:\\My Project"), { projectPath: "E:\\My Project" });
  assert.deepEqual(installProbeRequest({ previewId: "p1" }), { previewId: "p1" });
  assert.deepEqual(installProbeRequest({ operationId: "op1" }), { operationId: "op1" });
  assert.deepEqual(installRollbackRequest("op1"), { operationId: "op1" });
  assert.deepEqual(installCancelRequest("p1"), { previewId: "p1" });
});

// ---------------- ② 真实 handler 工厂 ----------------

interface Harness {
  calls: string[];
  state: Record<string, unknown>;
  handlers: ReturnType<typeof createUnityInstallHandlers>;
}

function harness(over: Partial<UnityInstallHandlerDeps> & {
  preview?: UnityInstallPreview | null;
  replaceConfirmed?: boolean;
  operationId?: string | null;
  projectPath?: string;
  apiOverrides?: Partial<UnityInstallHandlerDeps["api"]>;
} = {}): Harness {
  const calls: string[] = [];
  const state: Record<string, unknown> = {
    preview: over.preview === undefined ? preview() : over.preview,
    replaceConfirmed: over.replaceConfirmed ?? false,
    // 默认 null：不再靠预置 op1 自证；需要 id 的用例显式传入。
    operationId: over.operationId === undefined ? null : over.operationId,
    projectPath: over.projectPath ?? "E:\\My Project",
  };
  const deps: UnityInstallHandlerDeps = {
    api: {
      preview: (p) => { calls.push("api:preview:" + p); return Promise.resolve(preview()); },
      apply: (id, rep) => { calls.push("api:apply:" + id + ":" + String(rep)); return Promise.resolve(applyResult()); },
      operation: (id) => { calls.push("api:operation:" + id); return Promise.resolve(operation()); },
      rollback: (id) => { calls.push("api:rollback:" + id); return Promise.resolve(operation({ status: "rolled_back" })); },
      cancelPreview: (id) => { calls.push("api:cancel:" + id); return Promise.resolve({ cancelled: true }); },
      status: (p) => { calls.push("api:status:" + p); return Promise.resolve(status()); },
      probe: (i) => { calls.push("api:probe:" + JSON.stringify(i)); return Promise.resolve(probe()); },
    },
    getProjectPath: () => String(state.projectPath),
    getPreview: () => state.preview as UnityInstallPreview | null,
    getReplaceConfirmed: () => Boolean(state.replaceConfirmed),
    getOperationId: () => state.operationId as string | null,
    setPreview: (p) => { state.preview = p; calls.push("setPreview:" + (p ? p.previewId : "null")); },
    // 镜像真实 React：setOperation 后 getOperationId 必须能读到该 id。
    setOperation: (o) => {
      state.operation = o;
      state.operationId = o ? o.operationId : null;
      calls.push("setOperation:" + (o ? o.operationId : "null"));
    },
    setStatus: (s) => { state.status = s; calls.push("setStatus:" + (s ? s.config : "null")); },
    setProbe: (p) => { state.probe = p; calls.push("setProbe:" + (p ? p.bridge : "null")); },
    setError: (e) => { state.error = e; calls.push("setError:" + e); },
    setBusy: (b) => calls.push("setBusy:" + b),
    onToast: (k, t) => calls.push("toast:" + k + ":" + t),
    describeError: (e) => "ERR:" + String((e as Error)?.message ?? e),
    ...over,
  };
  if (over.apiOverrides) deps.api = { ...deps.api, ...over.apiOverrides };
  return { calls, state, handlers: createUnityInstallHandlers(deps) };
}

test("preview：空路径不请求；成功只生成预览并明确未写工程", async () => {
  const empty = harness({ projectPath: "   " });
  await empty.handlers.preview();
  assert.equal(empty.calls.some((c) => c.startsWith("api:preview:")), false, "空路径不得请求");
  assert.ok(empty.calls.some((c) => c.startsWith("toast:bad:")), "空路径必须提示");

  const h = harness();
  await h.handlers.preview();
  assert.deepEqual(h.calls.filter((c) => c.startsWith("api:preview:")), ["api:preview:E:\\My Project"]);
  assert.ok(h.calls.includes("setPreview:p1"));
  assert.ok(h.calls.some((c) => c.startsWith("toast:info:") && c.includes("未写入")), "必须说明预览不写工程");
});

test("apply：replace 未确认不请求；确认后 body 只带 previewId/confirm/confirmReplace", async () => {
  const blocked = harness({ preview: preview({ package: { ...preview().package, change: "replace" } }), replaceConfirmed: false });
  await blocked.handlers.apply();
  assert.equal(blocked.calls.some((c) => c.startsWith("api:apply:")), false, "replace 未确认不得 apply");
  assert.ok(blocked.calls.some((c) => c.startsWith("toast:bad:")), "必须提示先确认替换");

  const ok = harness({ replaceConfirmed: true });
  await ok.handlers.apply();
  assert.deepEqual(ok.calls.filter((c) => c.startsWith("api:apply:")), ["api:apply:p1:true"]);
  assert.ok(ok.calls.some((c) => c.startsWith("toast:ok:") && c.includes("配置已写入")), "成功文案只承诺配置写入");
  assert.equal(ok.calls.some((c) => c.startsWith("toast:ok:") && /UPM|编译|桥接/.test(c) && !c.includes("未验证")), false, "不得宣称 UPM/编译/桥接成功");
});

test("cancel：只取消预览、0 apply；失败不假成功", async () => {
  const h = harness();
  await h.handlers.cancel();
  assert.deepEqual(h.calls.filter((c) => c.startsWith("api:cancel:")), ["api:cancel:p1"]);
  assert.equal(h.calls.some((c) => c.startsWith("api:apply:")), false, "取消不得 apply");
  assert.ok(h.calls.includes("setPreview:null"), "取消后清空预览");

  const bad = harness({ apiOverrides: { cancelPreview: () => Promise.reject(new Error("boom")) } });
  await bad.handlers.cancel();
  assert.ok(bad.calls.some((c) => c.startsWith("setError:") && c !== "setError:"), "取消失败必须报错");
  assert.equal(bad.calls.some((c) => c.startsWith("toast:ok:")), false, "取消失败不得假成功");
});

test("status/probe/rollback：各自请求；probe 显式 POST 且带 previewId/operationId", async () => {
  const h = harness();
  await h.handlers.status();
  assert.deepEqual(h.calls.filter((c) => c.startsWith("api:status:")), ["api:status:E:\\My Project"]);
  assert.ok(h.calls.includes("setStatus:applied"));

  const p = harness();
  await p.handlers.probe();
  assert.deepEqual(p.calls.filter((c) => c.startsWith("api:probe:")), ['api:probe:{"previewId":"p1"}']);

  const r = harness({ operationId: "op1" });
  await r.handlers.rollback();
  assert.deepEqual(r.calls.filter((c) => c.startsWith("api:rollback:")), ["api:rollback:op1"]);
  assert.ok(r.calls.includes("setOperation:op1"));
});

test("apply 成功后用真实 operationId 拉 operation，并让 probe/rollback 使用同一 id", async () => {
  const h = harness({ preview: preview(), operationId: null });
  await h.handlers.apply();
  assert.deepEqual(h.calls.filter((c) => c.startsWith("api:apply:")), ["api:apply:p1:false"]);
  assert.ok(h.calls.includes("api:operation:op1"), "apply 成功后必须按真实 operationId 拉 operation");
  assert.ok(h.calls.includes("setOperation:op1"), "operation 必须写入状态");
  assert.equal(h.state.operationId, "op1", "setOperation 后 getOperationId 必须读到真实 id（镜像 React）");
  assert.ok(h.calls.includes("setPreview:null"), "已消费的 preview 必须清掉（M1 自然闭合）");

  // preview 已清 → probe 必须回落到 operationId
  await h.handlers.probe();
  assert.deepEqual(h.calls.filter((c) => c.startsWith("api:probe:")), ['api:probe:{"operationId":"op1"}']);

  // rollback 用同一真实 id（不再预置）
  await h.handlers.rollback();
  assert.deepEqual(h.calls.filter((c) => c.startsWith("api:rollback:")), ["api:rollback:op1"]);
});

test("already_installed（operationId=null）不拉 operation、不造 id", async () => {
  const h = harness({
    operationId: null,
    apiOverrides: { apply: () => Promise.resolve(applyResult({ operationId: null, status: "already_installed" })) },
  });
  await h.handlers.apply();
  assert.equal(h.calls.some((c) => c.startsWith("api:operation:")), false, "无 operationId 不得拉 operation");
  assert.equal(h.state.operationId, null, "不得伪造 operationId");
  assert.ok(h.calls.some((c) => c.startsWith("toast:ok:") && c.includes("未写文件")), "已安装同版本要如实说明");
});

test("already_installed 清掉上一 operation：rollback 无目标、不发旧 id", async () => {
  const h = harness({
    operationId: "op-old",
    apiOverrides: { apply: () => Promise.resolve(applyResult({ operationId: null, status: "already_installed" })) },
  });
  assert.equal(h.state.operationId, "op-old", "前置：旧 operation 在状态里（rollback 本可用）");
  await h.handlers.apply();
  assert.equal(h.calls.some((c) => c.startsWith("api:operation:")), false, "无 operationId 不得拉 operation");
  assert.ok(h.calls.includes("setOperation:null"), "already_installed 必须清掉上一 operation");
  assert.equal(h.state.operationId, null, "旧 operation 不得残留");

  await h.handlers.rollback();
  assert.equal(h.calls.some((c) => c.startsWith("api:rollback:")), false, "无目标时不得发 rollback（尤其不得发旧 id）");
  assert.ok(h.calls.some((c) => c.startsWith("toast:bad:")), "必须提示没有可回滚的操作");
});

test("operation 读取失败走错误通道，不假成功", async () => {
  const h = harness({
    operationId: null,
    apiOverrides: { operation: () => Promise.reject(new Error("boom")) },
  });
  await h.handlers.apply();
  assert.ok(h.calls.some((c) => c.startsWith("setError:") && c !== "setError:"), "operation 读取失败必须报错");
  assert.equal(h.calls.some((c) => c.startsWith("toast:ok:")), false, "不得假成功");
});

test("失败分支：错误非空且不写成功态（防 setError(\"\") 空转）", async () => {
  const boom = () => Promise.reject(new Error("boom"));
  const h = harness({
    apiOverrides: { preview: boom, apply: boom, operation: boom, rollback: boom, cancelPreview: boom, status: boom, probe: boom },
  });
  await h.handlers.preview();
  assert.ok(h.calls.some((c) => c.startsWith("setError:") && c !== "setError:"), "错误必须非空");
  assert.equal(h.calls.some((c) => c.startsWith("toast:ok:")), false, "失败不得假成功");
  assert.equal(h.calls.some((c) => c.startsWith("setPreview:")), false, "失败不得写入预览");
});
