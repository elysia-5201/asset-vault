/**
 * T3 只读 probe/status（真实 TMP 工程 + 闭合 loopback MCP stub / fakeMcp）。
 * 口径：status 零 Unity 调用；probe 先 Editor 信息再匹配；错工程 0 compile；unknown 不伪 ok。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnityMcp } from "../../apps/server/src/services/unity";
import { createPreview } from "../../apps/server/src/services/unity-install";
import { probeInstall, statusInstall } from "../../apps/server/src/services/unity-install-probe";
import { UNITY_MCP_PACKAGE_ID, UNITY_MCP_PACKAGE_URL } from "../../apps/server/src/services/unity-install-core";

function makeProject(root: string, withPackage = true): string {
  const project = join(root, "My Project");
  mkdirSync(join(project, "Packages"), { recursive: true });
  mkdirSync(join(project, "ProjectSettings"), { recursive: true });
  const deps = withPackage ? { [UNITY_MCP_PACKAGE_ID]: UNITY_MCP_PACKAGE_URL } : {};
  writeFileSync(join(project, "Packages", "manifest.json"), JSON.stringify({ dependencies: deps }, null, 2) + "\n");
  writeFileSync(join(project, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 2021.3.22f1\n");
  return project;
}

const depsOf = (dataDir: string, unityClient?: () => unknown) => ({
  dataDir,
  repo: { getSetting: () => "" },
  log: () => {},
  execFile: async () => ({ stdout: "ok" }),
  unityClient: unityClient as never,
});

const EXEC_SCHEMA = { type: "object", properties: { action: { type: "string" }, code: { type: "string" }, safety_checks: { type: "boolean" } } };

function fakeMcp(opts: { editorProject: string; compile?: "0" | "1"; compiling?: "0" | "1"; tools?: Array<{ name: string; inputSchema?: unknown }> }) {
  const state = { compileCalls: 0, connectCalls: 0, listCalls: 0 };
  const mcp = {
    endpoint: "http://127.0.0.1:0/mcp",
    serverName: "fake",
    async connect() { state.connectCalls++; return { url: "http://127.0.0.1:0/mcp", sid: "s", name: "fake", version: "1" }; },
    async listTools() { state.listCalls++; return opts.tools ?? [{ name: "execute_code", inputSchema: EXEC_SCHEMA }]; },
    async csharp(code: string) {
      if (code.includes("scriptCompilationFailed")) { state.compileCalls++; return opts.compile ?? "0"; }
      return "/p/Assets|" + opts.editorProject + "|2021.3.22f1|0|" + (opts.compiling ?? "0") + "|Assets/Scenes/a.unity";
    },
  };
  return { mcp, state };
}

test("UnityMcp.listTools：真实 loopback stub 的 tools/list", async () => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      const send = (obj: unknown, sid?: string) => {
        res.writeHead(200, { "content-type": "application/json", ...(sid ? { "mcp-session-id": sid } : {}) });
        res.end(JSON.stringify(obj));
      };
      if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "stub", version: "1" } } }, "sid-1");
      if (msg.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
      if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "execute_code", inputSchema: EXEC_SCHEMA }] } });
      return send({ jsonrpc: "2.0", id: msg.id, error: { message: "unknown method" } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const mcp = new UnityMcp(["http://127.0.0.1:" + port + "/mcp"], 5000);
    const tools = await mcp.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["execute_code"]);
    const schema = tools[0]?.inputSchema as { properties?: { action?: { type?: string } } };
    assert.equal(schema.properties?.action?.type, "string");
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});

test("statusInstall：只读磁盘，零 Unity 调用", () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-probe-"));
  try {
    const project = makeProject(root, true);
    const spy = { calls: 0 };
    const status = statusInstall(depsOf(root, () => { spy.calls++; throw new Error("must not call"); }), project);
    assert.equal(spy.calls, 0);
    assert.equal(status.config, "applied");
    assert.equal(status.compile, "unknown");
    assert.equal(status.bridge, "unknown");
    assert.equal(status.packageId, UNITY_MCP_PACKAGE_ID);
    assert.equal(status.targetVersion, "10.0.0");
    assert.equal(status.upm, "unknown");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("probeInstall：错工程 project_mismatch 且 0 compile 调用", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-probe-"));
  try {
    const project = makeProject(root, false);
    const deps = depsOf(root);
    const preview = await createPreview(deps, project);
    const { mcp, state } = fakeMcp({ editorProject: "/other/project" });
    const probe = await probeInstall({ ...deps, unityClient: () => mcp as never }, { previewId: preview.previewId });
    assert.equal(probe.projectMatch, false);
    assert.equal(probe.bridge, "project_mismatch");
    assert.equal(probe.compile, "unknown");
    assert.equal(state.compileCalls, 0);
    assert.equal(probe.server, "connected");
    assert.equal(probe.tool, "compatible");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("probeInstall：工程匹配 → connected/ok，并落盘供 status 读取", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-probe-"));
  try {
    const project = makeProject(root, false);
    const deps = depsOf(root);
    const preview = await createPreview(deps, project);
    const { mcp, state } = fakeMcp({ editorProject: project, compile: "0" });
    const probe = await probeInstall({ ...deps, unityClient: () => mcp as never }, { previewId: preview.previewId });
    assert.equal(probe.projectMatch, true);
    assert.equal(probe.bridge, "connected");
    assert.equal(probe.compile, "ok");
    assert.equal(state.compileCalls, 1);
    const status = statusInstall(deps, project);
    assert.equal(status.compile, "ok");
    assert.equal(status.bridge, "connected");
    assert.equal(status.tool, "compatible");
    assert.equal(status.server, "connected");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("probeInstall：MCP 不可达 → server unreachable，其余 unknown", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-probe-"));
  try {
    const project = makeProject(root, false);
    const deps = depsOf(root);
    const preview = await createPreview(deps, project);
    const down = {
      endpoint: "", serverName: "",
      async connect() { throw new Error("down"); },
      async listTools() { throw new Error("down"); },
      async csharp() { throw new Error("down"); },
    };
    const probe = await probeInstall({ ...deps, unityClient: () => down as never }, { previewId: preview.previewId });
    assert.equal(probe.server, "unreachable");
    assert.equal(probe.bridge, "unknown");
    assert.equal(probe.compile, "unknown");
    assert.equal(probe.tool, "unknown");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("probeInstall：listTools 缺 execute_code → tool incompatible", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-probe-"));
  try {
    const project = makeProject(root, false);
    const deps = depsOf(root);
    const preview = await createPreview(deps, project);
    const { mcp } = fakeMcp({ editorProject: project, tools: [] });
    const probe = await probeInstall({ ...deps, unityClient: () => mcp as never }, { previewId: preview.previewId });
    assert.equal(probe.tool, "incompatible");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("probeInstall：Editor 正在编译 → compile unknown，且不读旧编译标志", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-probe-"));
  try {
    const project = makeProject(root, false);
    const deps = depsOf(root);
    const preview = await createPreview(deps, project);
    const { mcp, state } = fakeMcp({ editorProject: project, compiling: "1", compile: "0" });
    const probe = await probeInstall({ ...deps, unityClient: () => mcp as never }, { previewId: preview.previewId });
    assert.equal(probe.projectMatch, true);
    assert.equal(probe.bridge, "connected");
    assert.equal(probe.compile, "unknown");
    assert.equal(state.compileCalls, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
