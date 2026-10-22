/** task-51：MCP loopback 边界 + /api/health build/unity_mcp。 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { openTempDb, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerRoutes } from "../../apps/server/src/http/routes";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";
import { unityMcpBoundary, isLoopbackMcpUrl, sanitizeMcpUrl, unityClientFor, UNITY_MCP_URLS } from "../../apps/server/src/services/unity";

let t: TempDb; let repo: Repo; let dir: string;
beforeEach(() => { t = openTempDb(); repo = new Repo(t.db); dir = mkdtempSync(join(tmpdir(), "av-mcp-")); });
afterEach(() => { t.close(); rmSync(dir, { recursive: true, force: true }); });

describe("MCP loopback", () => {
  test("默认只允许 loopback；非 loopback 被丢弃且日志不含 token", () => {
    assert.equal(isLoopbackMcpUrl("http://127.0.0.1:8080/mcp"), true);
    assert.equal(isLoopbackMcpUrl("http://localhost:8080/mcp"), true);
    assert.equal(isLoopbackMcpUrl("http://[::1]:8080/mcp"), true);
    assert.equal(isLoopbackMcpUrl("http://10.0.0.5:8080/mcp"), false);
    assert.equal(sanitizeMcpUrl("http://user:pass@10.0.0.5:8080/mcp?token=SECRET"), "http://10.0.0.5:8080/mcp");
    repo.setSetting("unity_mcp_url", "http://10.0.0.5:8080/mcp?token=SECRET");
    const b = unityMcpBoundary(repo);
    assert.equal(b.allowRemote, false);
    assert.deepEqual(b.dropped, ["http://10.0.0.5:8080/mcp"]);
    assert.ok(!JSON.stringify(b).includes("SECRET"), "边界信息不得泄露 token");
    assert.ok(b.urls.every((u) => isLoopbackMcpUrl(u)));
  });

  test("settings.unity_mcp_allow_remote=1 才允许远程", () => {
    repo.setSetting("unity_mcp_url", "http://10.0.0.5:8080/mcp");
    repo.setSetting("unity_mcp_allow_remote", "1");
    const b = unityMcpBoundary(repo);
    assert.equal(b.allowRemote, true);
    assert.ok(b.urls.includes("http://10.0.0.5:8080/mcp"));
    assert.equal(b.dropped.length, 0);
    assert.ok(UNITY_MCP_URLS.every((u) => isLoopbackMcpUrl(u)));
    assert.equal(unityClientFor(repo).endpoint, "http://10.0.0.5:8080/mcp");
  });

  test("health 暴露 build 与 unity_mcp（无 token）", async () => {
    repo.setSetting("unity_mcp_url", "http://10.0.0.5:8080/mcp?token=SECRET");
    const app = Fastify({ logger: false });
    registerRoutes(app as any, {
      repo, media: {} as any, booth: {} as any, runner: {} as any, log: () => {}, version: "0.7.1",
      dbPath: join(dir, "t.db"), dataDir: dir, pipeline: null, limits: resolveLimits({}),
      build: { version: "0.7.1", commit: "abc123", builtAt: "2026-10-22T00:00:00.000Z", serverSha256: "f00" },
    } as any);
    const res = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.build, { version: "0.7.1", commit: "abc123", builtAt: "2026-10-22T00:00:00.000Z", serverSha256: "f00" });
    assert.equal(body.unity_mcp.dropped.length, 1);
    assert.ok(!res.body.includes("SECRET"));
  });
});
