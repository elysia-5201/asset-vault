/**
 * 可靠性批次 1（task-1）：本机工具边界回归。
 * A：旧 routes 构建路径也必须受 loopback 边界约束；settings 校验 URL 形状/协议/未授权远端，且不泄露凭据。
 * B：旧 /api/unity/import 直导不得绕过 计划 → 风险确认 → 作业 链；计划路径保持正常。
 * C：HTTP 监听默认只允许 loopback（本机工具，无账号/token 体系）。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { openTempDb, addItem, addRoot, addAsset, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerRoutes } from "../../apps/server/src/http/routes";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";
import { validateUnityMcpUrl } from "../../apps/server/src/services/unity";
import { assertLocalListenHost, isLoopbackListenHost } from "../../apps/server/src/listen-host";

let t: TempDb; let repo: Repo; let rootId: number; let dir: string;
beforeEach(() => { t = openTempDb(); repo = new Repo(t.db); rootId = addRoot(t.db, "/lib"); dir = mkdtempSync(join(tmpdir(), "av-guard-")); });
afterEach(() => { try { t.close(); } catch { /* ignore */ } rmSync(dir, { recursive: true, force: true }); });

const app = () => {
  const a = Fastify({ logger: false });
  registerRoutes(a as any, {
    repo, media: {} as any, booth: {} as any, runner: {} as any, log: () => {}, version: "test",
    dbPath: join(dir, "t.db"), dataDir: dir, pipeline: null, limits: resolveLimits({}),
  } as any);
  return a;
};

function unitOf(title: string) {
  const itemId = addItem(t.db, { title });
  const path = join(dir, title + ".unitypackage");
  writeFileSync(path, Buffer.alloc(8, 1));
  const assetId = addAsset(t.db, itemId, rootId, path, { kind: "unitypackage", container: "unitypackage", path, path_norm: path, size: 8, mtime: "2026-10-02T00:00:00.000Z" });
  const ids = repo.replaceAssetUnits(assetId, itemId, [{
    relPath: "pkg.unitypackage", format: "unitypackage", kind: "unitypackage", name: "pkg", size: 8,
    fingerprint: "8:2026-10-02T00:00:00.000Z:", policy: "single_unitypackage", importable: true,
    parseState: "ok", avatars: [], evidence: {},
  }]);
  return { itemId, assetId, unitId: ids.get("pkg.unitypackage")! };
}

describe("A: settings 里的 Unity MCP 地址校验", () => {
  test("只接受 http/https 回环地址；非回环必须显式 allowRemote", () => {
    assert.equal(validateUnityMcpUrl("http://127.0.0.1:8080/mcp").ok, true);
    assert.equal(validateUnityMcpUrl("https://127.0.0.1:8080/mcp").ok, true);
    assert.equal(validateUnityMcpUrl("http://localhost:14523/mcp").ok, true);
    assert.equal(validateUnityMcpUrl("").ok, true, "空值 = 用默认候选");

    for (const bad of ["ftp://127.0.0.1/mcp", "file:///etc/passwd", "javascript:alert(1)", "127.0.0.1:8080/mcp", "http://"]) {
      assert.equal(validateUnityMcpUrl(bad).ok, false, "应拒绝非法形状/协议：" + bad);
    }
    assert.equal(validateUnityMcpUrl("http://user:pass@127.0.0.1:8080/mcp").ok, false, "不得内嵌凭据");
    const remote = validateUnityMcpUrl("http://10.0.0.5:8080/mcp");
    assert.equal(remote.ok, false);
    assert.equal(remote.ok === false && remote.code, "REMOTE_NOT_ALLOWED");
    assert.equal(validateUnityMcpUrl("http://10.0.0.5:8080/mcp", { allowRemote: true }).ok, true);
  });

  test("PUT /api/settings 拒绝未授权远端与非法协议，回环地址可保存", async () => {
    let res = await app().inject({ method: "PUT", url: "/api/settings", payload: { unityMcpUrl: "ftp://127.0.0.1/mcp" } });
    assert.equal(res.statusCode, 400);
    res = await app().inject({ method: "PUT", url: "/api/settings", payload: { unityMcpUrl: "http://10.0.0.5:8080/mcp" } });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error.code, "REMOTE_NOT_ALLOWED");
    assert.equal((repo.getSetting("unity_mcp_url") ?? ""), "", "被拒的地址不得落库");

    res = await app().inject({ method: "PUT", url: "/api/settings", payload: { unityMcpUrl: "http://127.0.0.1:14523/mcp" } });
    assert.equal(res.statusCode, 200);
    assert.equal(repo.getSetting("unity_mcp_url"), "http://127.0.0.1:14523/mcp");

    // 显式 opt-in 后才允许远程
    repo.setSetting("unity_mcp_allow_remote", "1");
    res = await app().inject({ method: "PUT", url: "/api/settings", payload: { unityMcpUrl: "http://10.0.0.5:8080/mcp" } });
    assert.equal(res.statusCode, 200);
  });

  test("GET settings/status 不回显 URL 里的用户名密码", async () => {
    repo.setSetting("unity_mcp_url", "http://user:pass@127.0.0.1:8080/mcp?token=SECRET");
    const a = app();
    for (const url of ["/api/settings", "/api/health"]) {
      const res = await a.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200);
      assert.ok(!res.body.includes("user:pass"), url + " 不得泄露 URL 凭据");
    }
  });
});

describe("A: 旧 /api/unity/status 构建路径受同一边界约束", () => {
  test("非回环地址被丢弃：不连接、不回显主机与 token", async () => {
    repo.setSetting("unity_mcp_url", "http://10.0.0.5:8080/mcp?token=SECRET");
    const res = await app().inject({ method: "GET", url: "/api/unity/status" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(!res.body.includes("10.0.0.5"), "不得把被丢弃的远端地址回显给前端");
    assert.ok(!res.body.includes("SECRET"), "不得泄露 token");
    assert.ok(Array.isArray(body.candidates) && body.candidates.length > 0);
    assert.ok(body.candidates.every((c: string) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(c)), "候选只能是回环：" + JSON.stringify(body.candidates));
    assert.ok(Number(body.dropped) >= 1, "应报告被丢弃的远端数量");
  });

  test("正常路径：回环地址仍是候选，/api/unity/packages 照常工作", async () => {
    repo.setSetting("unity_mcp_url", "http://127.0.0.1:14523/mcp");
    const a = app();
    const status = JSON.parse((await a.inject({ method: "GET", url: "/api/unity/status" })).body);
    assert.equal(status.dropped, 0);
    assert.ok(status.candidates.includes("http://127.0.0.1:14523/mcp"));

    const u = unitOf("packages");
    const res = await a.inject({ method: "GET", url: "/api/unity/packages?itemId=" + u.itemId });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.packages) && body.packages.length >= 1, "列包能力不受边界修复影响");
  });
});

describe("B: 旧直导接口不得绕过 计划→风险确认→作业", () => {
  test("POST /api/unity/import 返回可操作的弃用迁移错误，且没有副作用", async () => {
    const u = unitOf("legacy");
    const res = await app().inject({ method: "POST", url: "/api/unity/import", payload: { itemId: u.itemId, keys: [] } });
    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, "UNITY_IMPORT_REQUIRES_PLAN");
    assert.match(body.error.message, /\/api\/import-plans/);
    assert.ok(body.error.migration && typeof body.error.migration.plan === "string");
    const ledger = t.db.prepare("SELECT COUNT(*) c FROM project_imports").get() as { c: number } | undefined;
    assert.equal(Number(ledger?.c ?? 0), 0, "直导接口不得写导入台账");
    assert.equal(existsSync(join(dir, "unity-staging")), false, "直导接口不得落地 staging");
  });

  test("正常路径：计划 → confirm → execute 仍然可用（202 + jobId）", async () => {
    const u = unitOf("plan");
    const a = app();
    const created = await a.inject({ method: "POST", url: "/api/import-plans", payload: { unitIds: [u.unitId], projectPath: dir } });
    assert.equal(created.statusCode, 201);
    const view = JSON.parse(created.body);
    const planId = Number(view.plan.id);
    assert.ok(planId > 0);

    const confirmed = await a.inject({ method: "POST", url: "/api/import-plans/" + planId + "/confirm", payload: { riskAck: true } });
    assert.equal(confirmed.statusCode, 200);

    const exec = await a.inject({ method: "POST", url: "/api/import-plans/" + planId + "/execute", payload: {} });
    assert.equal(exec.statusCode, 202);
    const ack = JSON.parse(exec.body) as { jobId?: number; planId?: number };
    assert.ok(Number(ack.jobId) > 0);
    assert.equal(Number(ack.planId), planId);
  });
});

describe("C: HTTP 监听默认只允许 loopback", () => {
  test("listen host 判定与默认拒绝", () => {
    assert.equal(isLoopbackListenHost("127.0.0.1"), true);
    assert.equal(isLoopbackListenHost("localhost"), true);
    assert.equal(isLoopbackListenHost("::1"), true);
    assert.equal(isLoopbackListenHost("[::1]"), true);
    assert.equal(isLoopbackListenHost("0.0.0.0"), false);
    assert.equal(isLoopbackListenHost("192.168.1.7"), false);
    assert.equal(assertLocalListenHost("127.0.0.1", { allowRemote: false }), "127.0.0.1");
    assert.throws(() => assertLocalListenHost("0.0.0.0", { allowRemote: false }), /ASSETVAULT_ALLOW_REMOTE_LISTEN/);
    assert.equal(assertLocalListenHost("0.0.0.0", { allowRemote: true }), "0.0.0.0");
  });

  test("server 监听前真的走了这道闸（源码级回归，防被删）", () => {
    const src = readFileSync(fileURLToPath(new URL("../../apps/server/src/server.ts", import.meta.url)), "utf8");
    const gate = src.indexOf("assertLocalListenHost(");
    const listen = src.indexOf("fastify.listen(");
    assert.ok(gate >= 0, "server.ts 必须调用 assertLocalListenHost");
    assert.ok(listen > gate, "必须在 listen 之前调用闸门");
  });
});
