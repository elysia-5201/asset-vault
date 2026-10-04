/**
 * Unity 桥的确定性单测：MCP 协议解析、握手/调用（对着假 MCP 服务器）、路径翻译、包发现。
 * 真的连 Unity 编辑器的那部分不在这里（那是 scripts/unity-e2e.mjs 的事）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { UnityMcp, parseMcpBody, translateToHost, listUnityPackageCandidates, type UnityPackageCandidate } from "../src/services/unity";

test("parseMcpBody：纯 JSON 与 SSE 两种响应都能解", () => {
  assert.deepEqual(parseMcpBody('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'), { jsonrpc: "2.0", id: 1, result: { ok: true } });
  const sse = 'event: message\ndata: {"a":1}\n\nevent: message\ndata: {"b":2}\n\n';
  assert.deepEqual(parseMcpBody(sse), { b: 2 });
  assert.equal(parseMcpBody(""), null);
  assert.equal(parseMcpBody("not json at all"), null);
});

test("translateToHost：/mnt/<盘> → 盘符；其余 → \\wsl.localhost\<distro>；已经是 Windows 路径就原样", () => {
  assert.equal(translateToHost("/mnt/e/tool/asset-vault/data/unity-staging/4/a.unitypackage", "Ubuntu-26.04-LTS"), "E:\\tool\\asset-vault\\data\\unity-staging\\4\\a.unitypackage");
  assert.equal(translateToHost("/root/Code/x.unitypackage", "Ubuntu-26.04-LTS"), "\\\\wsl.localhost\\Ubuntu-26.04-LTS\\root\\Code\\x.unitypackage");
  assert.equal(translateToHost("/root/Code/x.unitypackage", ""), "/root/Code/x.unitypackage");
  assert.equal(translateToHost("E:\\tool\\x.unitypackage", "Ubuntu-26.04-LTS"), "E:\\tool\\x.unitypackage");
});

/** 假 repo：只实现 listUnityPackageCandidates 用到的三个方法。 */
function fakeRepo(assets: any[], entries: Record<number, any[]>) {
  return {
    listAssets: () => assets,
    getArchiveEntries: (id: number) => entries[id] ?? [],
    replaceArchiveEntries: () => undefined,
  } as any;
}

test("listUnityPackageCandidates：.unitypackage 直接算；压缩包内的按 size 排序；未索引的压缩包不炸", async () => {
  const repo = fakeRepo(
    [
      { id: 1, container: "unitypackage", path: "E:\\lib\\Direct.unitypackage", size: 111 },
      { id: 2, container: "7z", path: "E:\\lib\\Bundle.7z", size: 999 },
      { id: 3, container: "zip", path: "E:\\lib\\Missing.zip", size: 1 }, // entries 为空且 listArchive 读不到 → 跳过
    ],
    { 2: [
      { path: "Set/Small.unitypackage", size: 2048, isDir: 0 },
      { path: "Set/Big.unitypackage", size: 8192, isDir: 0 },
      { path: "Set/readme.txt", size: 100, isDir: 0 },
      { path: "Set/tiny.unitypackage", size: 512, isDir: 0 }, // < 1KB 的忽略
    ] },
  );
  const out = await listUnityPackageCandidates(repo, 4);
  assert.deepEqual(out.map((c: UnityPackageCandidate) => c.label), ["Big.unitypackage", "Small.unitypackage", "Direct.unitypackage"]);
  assert.deepEqual(out.map((c) => c.key), ["2|Set/Big.unitypackage", "2|Set/Small.unitypackage", "1|"]);
  assert.equal(out[0]!.entryPath, "Set/Big.unitypackage");
  assert.equal(out[2]!.entryPath, null);
  assert.deepEqual(out.map((c) => c.size), [8192, 2048, 111]);
});

/** 起一个假 MCP 服务器（Streamable HTTP，SSE 响应），按脚本回答 initialize / tools/call。 */
async function fakeMcp(handler: (name: string, args: any) => any) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "sess-1" });
        res.end("event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fake-unity", version: "9.9" } } }) + "\n\n");
        return;
      }
      if (msg.method === "notifications/initialized") { res.writeHead(202).end(); return; }
      if (msg.method === "tools/call") {
        const payload = handler(msg.params?.name, msg.params?.arguments);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: payload }));
        return;
      }
      res.writeHead(400).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  return { url: "http://127.0.0.1:" + port + "/mcp", close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("UnityMcp：握手 + execute_code 取结构化返回值", async () => {
  const srv = await fakeMcp((name) => ({ content: [{ type: "text", text: "raw" }], structuredContent: { success: true, data: { result: "NAME=" + name } } }));
  try {
    const u = new UnityMcp([srv.url], 5000);
    assert.equal(await u.csharp("whatever"), "NAME=execute_code");
    assert.equal(u.endpoint, srv.url);
    assert.equal(u.serverName, "fake-unity");
  } finally { await srv.close(); }
});

test("UnityMcp：编辑器没连上 / 编译失败 → csharp 抛错并带上原文", async () => {
  const srv = await fakeMcp(() => ({ content: [{ type: "text", text: "Compilation failed: CS1002" }], structuredContent: { success: false, message: "Compilation failed", data: null } }));
  try {
    const u = new UnityMcp([srv.url], 5000);
    await assert.rejects(() => u.csharp("bad code"), /Compilation failed/);
  } finally { await srv.close(); }
});

test("UnityMcp：端点全挂 → connect 抛 UPSTREAM_ERROR（前端据此显示未连接）", async () => {
  const u = new UnityMcp(["http://127.0.0.1:1/mcp"], 1500);
  await assert.rejects(() => u.csharp("x"), (e: any) => e.code === "UPSTREAM_ERROR" || /连不上 Unity MCP/.test(String(e.message)));
});
