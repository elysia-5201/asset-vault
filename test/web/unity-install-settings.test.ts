/**
 * Unity 一键安装：typed client 与 SettingsPanel 接线（T4；brief task-4-task-4-brief.md:50-56）。
 *
 * ① 关闭网络的 fetch stub：断言真实 request 的 method/URL/JSON body 与错误 details 透传；
 * ② SettingsPanel 源码静态补充：section/testid/导入名存在 —— **不是 DOM 执行**，真实 Chrome 归 T5。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ApiError, unityInstallApply, unityInstallCancelPreview, unityInstallOperation, unityInstallPreview,
  unityInstallProbe, unityInstallRollback, unityInstallStatus,
} from "../../apps/web/src/api";

interface StubCall { url: string; method: string; body: unknown }

function stubFetch(responder: (call: StubCall) => Response): { calls: StubCall[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: StubCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call: StubCall = { url, method, body };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const PROJECT = "E:\\My Project";

test("preview/apply：POST 路径与 body 精确；apply 只带 previewId/confirm/confirmReplace", async () => {
  const stub = stubFetch((call) => {
    if (call.url.endsWith("/preview")) return json({ previewId: "p1" });
    return json({ operationId: "op1", status: "config_applied", manifestHash: "h1", backupDir: null, warnings: [] });
  });
  try {
    await unityInstallPreview(PROJECT);
    assert.deepEqual(stub.calls[0], { url: "/api/unity/install/preview", method: "POST", body: { projectPath: PROJECT } });

    await unityInstallApply("p1", false);
    assert.deepEqual(stub.calls[1], {
      url: "/api/unity/install/apply", method: "POST",
      body: { previewId: "p1", confirm: true, confirmReplace: false },
    });

    await unityInstallApply("p1", true);
    assert.deepEqual(stub.calls[2].body, { previewId: "p1", confirm: true, confirmReplace: true });
  } finally { stub.restore(); }
});

test("status 是 GET 查询参数；probe 是显式 POST；operation/rollback/cancel 各自路径", async () => {
  const stub = stubFetch((call) => {
    if (call.url.includes("/status")) return json({ config: "applied" });
    if (call.url.includes("/rollback")) return json({ operationId: "op1", status: "rolled_back" });
    if (call.url.includes("/cancel")) return json({ cancelled: true });
    if (call.url.includes("/probe")) return json({ projectMatch: false });
    return json({ operationId: "op1", status: "config_applied" });
  });
  try {
    await unityInstallStatus(PROJECT);
    assert.equal(stub.calls[0].method, "GET");
    // 既有 queryString 用 URLSearchParams（空格编码为 +），与全仓其它 GET 查询一致。
    assert.equal(stub.calls[0].url, "/api/unity/install/status?" + new URLSearchParams({ projectPath: PROJECT }).toString());
    assert.equal(stub.calls[0].body, undefined);

    await unityInstallProbe({ previewId: "p1" });
    assert.deepEqual(stub.calls[1], { url: "/api/unity/install/probe", method: "POST", body: { previewId: "p1" } });

    await unityInstallProbe({ operationId: "op1" });
    assert.deepEqual(stub.calls[2].body, { operationId: "op1" });

    await unityInstallOperation("op1");
    assert.deepEqual(stub.calls[3], { url: "/api/unity/install/operations/op1", method: "GET", body: undefined });

    await unityInstallRollback("op1");
    assert.deepEqual(stub.calls[4], {
      url: "/api/unity/install/operations/op1/rollback", method: "POST", body: { confirm: true },
    });

    await unityInstallCancelPreview("p1");
    assert.deepEqual(stub.calls[5], { url: "/api/unity/install/previews/p1/cancel", method: "POST", body: undefined });
  } finally { stub.restore(); }
});

test("失败不假成功：409 details.code 原样透传（UNITY_INSTALL_LOCKED）", async () => {
  const stub = stubFetch(() => json({
    error: { code: "CONFLICT", message: "该工程正在应用", details: { code: "UNITY_INSTALL_LOCKED" } },
  }, 409));
  try {
    await assert.rejects(unityInstallApply("p1", false), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "CONFLICT");
      assert.equal(err.details?.code, "UNITY_INSTALL_LOCKED");
      return true;
    });
  } finally { stub.restore(); }
});

// ---------------- ② SettingsPanel 静态接线（非 DOM） ----------------

const PANEL = fileURLToPath(new URL("../../apps/web/src/components/SettingsPanel.tsx", import.meta.url));

test("SettingsPanel 导入真实 client/helper 并带全部 testid（静态补充，非 DOM）", () => {
  const src = readFileSync(PANEL, "utf8");
  for (const name of [
    "unityInstallPreview", "unityInstallApply", "unityInstallStatus", "unityInstallProbe",
    "unityInstallRollback", "unityInstallCancelPreview", "installCanApply", "installApplyBody",
  ]) assert.match(src, new RegExp(name), "SettingsPanel 缺 " + name);
  for (const id of [
    "unity-install-section", "unity-install-project", "unity-install-preview", "unity-install-apply",
    "unity-install-status", "unity-install-probe", "unity-install-rollback", "unity-install-cancel",
  ]) assert.match(src, new RegExp(id), "SettingsPanel 缺 testid " + id);
  // 工程输入初始为空：不得从 settings/downloadRoot 预填
  assert.match(src, /useState\(""\)/, "工程路径 state 必须初始为空串");
  assert.equal(/unityInstallProject.*settings\?\./.test(src), false, "不得用 settings 预填工程路径");
});
