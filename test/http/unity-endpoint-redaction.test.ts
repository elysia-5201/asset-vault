/**
 * 修复轮 2（总指挥裁决）：
 * - getUnityEditorInfo 成功返回的 endpoint 也必须脱敏（成功路径泄漏属于原安全目标），
 *   但真实 MCP 连接仍必须使用带 token 的原始 URL（离线 fake fetch，不连 Unity）。
 * - 非回环 URL 的 400 提示按设置面板可见名称，不再指导数据库内部键。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { openTempDb, addRoot, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerRoutes } from "../../apps/server/src/http/routes";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";

let t: TempDb; let repo: Repo; let dir: string;
beforeEach(() => { t = openTempDb(); repo = new Repo(t.db); addRoot(t.db, "/lib"); dir = mkdtempSync(join(tmpdir(), "av-endpoint-redact-")); });
afterEach(() => { try { t.close(); } catch { /* ignore */ } rmSync(dir, { recursive: true, force: true }); });

const app = () => {
  const a = Fastify({ logger: false });
  registerRoutes(a as any, {
    repo, media: {} as any, booth: {} as any, runner: {} as any, log: () => {}, version: "test",
    dbPath: join(dir, "t.db"), dataDir: dir, pipeline: null, limits: resolveLimits({}),
  } as any);
  return a;
};

const json = (obj: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json", ...headers } });

/** 离线假 MCP：initialize → notifications/initialized → tools/call 全成功，并记录真实请求 URL。 */
function installFakeMcp(seen: string[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    seen.push(url);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.method === "initialize") {
      return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fake-unity", version: "1.0.0" } } },
        { "mcp-session-id": "sess-1" });
    }
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (body.method === "tools/call") {
      return json({ jsonrpc: "2.0", id: body.id, result: {
        content: [{ type: "text", text: "ok" }],
        structuredContent: { success: true, data: { result: "C:/Proj/Assets|C:/Proj|2022.3.22f1|0|0|Assets/Main.unity" } },
      } });
    }
    return new Response("bad request", { status: 400 });
  }) as any;
  return () => { globalThis.fetch = original; };
}

describe("成功路径：editor endpoint 脱敏，真实连接仍用原始带 token URL", () => {
  test("/unity/status 成功回包不含 token，结构与工程信息不变", async () => {
    const seen: string[] = [];
    const restore = installFakeMcp(seen);
    try {
      repo.setSetting("unity_mcp_url", "http://127.0.0.1:8080/mcp?token=TOPSECRET");
      const res = await app().inject({ method: "GET", url: "/api/unity/status" });
      assert.equal(res.statusCode, 200, res.body);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true, res.body);
      // 数据结构不变（前端依赖这些字段）
      assert.deepEqual(Object.keys(body.editor).sort(), ["dataPath", "endpoint", "isCompiling", "isPlaying", "projectName", "projectPath", "scenePath", "serverName", "unityVersion"]);
      assert.equal(body.editor.endpoint, "http://127.0.0.1:8080/mcp", "公开的 editor.endpoint 必须脱敏");
      assert.equal(body.endpoint, "http://127.0.0.1:8080/mcp", "顶层 endpoint 同样脱敏");
      assert.equal(body.editor.projectPath, "C:/Proj");
      assert.equal(body.editor.unityVersion, "2022.3.22f1");
      assert.equal(body.serverName, "fake-unity");
      assert.ok(!res.body.includes("TOPSECRET"), "成功回包不得回显 query token：" + res.body);
      assert.ok(seen.some((u) => u.includes("token=TOPSECRET")), "真实 MCP 请求仍必须用带 token 的原始 URL：" + JSON.stringify(seen));
    } finally { restore(); }
  });

  test("非回环 URL 的 400 提示用设置面板可见名称，不含内部键", async () => {
    const res = await app().inject({ method: "PUT", url: "/api/settings", payload: { unityMcpUrl: "http://10.0.0.5:8080/mcp" } });
    assert.equal(res.statusCode, 400);
    const msg = String(JSON.parse(res.body).error.message ?? "");
    assert.match(msg, /允许非回环 Unity MCP 端点/, "提示应与设置面板标签一致：" + msg);
    assert.ok(!msg.includes("unity_mcp_allow_remote"), "不得指导用户改数据库内部键：" + msg);
    assert.equal(repo.getSetting("unity_mcp_url") ?? "", "", "400 时不得落库");
  });
});
