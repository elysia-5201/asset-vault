/**
 * T5 fixture safety/behavior tests.
 *
 * These tests only use fresh TMP directories and this process's own AssetVault
 * instance. They do not touch the user's app, production DB, real Unity, or 7317.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnityMcp } from "../../apps/server/src/services/unity";
import { startUnityInstallFixture } from "./unity-install-fixture-server";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "av-unity-fixture-"));
}

function mcpInit(): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  };
}

async function startFixture(tmp: string, name: string) {
  return startUnityInstallFixture({
    dataDir: join(tmp, name, "data"),
    logsDir: join(tmp, name, "logs"),
    host: "127.0.0.1",
    port: 0,
  });
}

test("rejects non-TMP dataDir", async () => {
  const tmp = tempRoot();
  try {
    await assert.rejects(
      () => startUnityInstallFixture({ dataDir: join(tmpdir(), "..", "av-fixture-outside-tmp", "data"), logsDir: join(tmp, "logs") }),
      /TMP/,
    );
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("rejects non-TMP logsDir", async () => {
  const tmp = tempRoot();
  try {
    await assert.rejects(
      () => startUnityInstallFixture({ dataDir: join(tmp, "data"), logsDir: join(tmpdir(), "..", "av-fixture-outside-tmp", "logs") }),
      /TMP/,
    );
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("rejects relative/empty paths", async () => {
  const tmp = tempRoot();
  try {
    await assert.rejects(() => startUnityInstallFixture({ dataDir: "relative", logsDir: join(tmp, "logs") }), /TMP/);
    await assert.rejects(() => startUnityInstallFixture({ dataDir: "", logsDir: join(tmp, "logs") }), /non-empty/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("rejects non-loopback host and reserved/invalid ports", async () => {
  const tmp = tempRoot();
  try {
    await assert.rejects(() => startUnityInstallFixture({ dataDir: join(tmp, "data"), logsDir: join(tmp, "logs"), host: "0.0.0.0" }), /127\.0\.0\.1/);
    await assert.rejects(() => startUnityInstallFixture({ dataDir: join(tmp, "data"), logsDir: join(tmp, "logs"), host: "localhost" }), /127\.0\.0\.1/);
    await assert.rejects(() => startUnityInstallFixture({ dataDir: join(tmp, "data"), logsDir: join(tmp, "logs"), port: 7317 }), /7317/);
    await assert.rejects(() => startUnityInstallFixture({ dataDir: join(tmp, "data"), logsDir: join(tmp, "logs"), port: 70000 }), /0\.\.65535/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("rejects same data/log dir and existing file", async () => {
  const tmp = tempRoot();
  try {
    const same = join(tmp, "same");
    await assert.rejects(() => startUnityInstallFixture({ dataDir: same, logsDir: same }), /different/);
    const file = join(tmp, "file");
    writeFileSync(file, "x");
    await assert.rejects(() => startUnityInstallFixture({ dataDir: file, logsDir: join(tmp, "logs") }), /directory/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("rejects directory link ancestor before writing", async () => {
  const tmp = tempRoot();
  try {
    const real = join(tmp, "real");
    mkdirSync(real);
    const link = join(tmp, "link");
    const directoryLink = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(real, link, directoryLink);
    try {
      await assert.rejects(
        () => startUnityInstallFixture({ dataDir: join(link, "data"), logsDir: join(tmp, "logs") }),
        /symlink/,
      );
    } finally { unlinkSync(link); }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("rejects dangling symlink before writing", async (context) => {
  const tmp = tempRoot();
  try {
    const dangling = join(tmp, "dangling");
    try { symlinkSync(join(tmp, "missing"), dangling, "dir"); }
    catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip("Windows requires permission to create directory symlinks");
        return;
      }
      throw error;
    }
    try {
      await assert.rejects(
        () => startUnityInstallFixture({ dataDir: join(dangling, "data"), logsDir: join(tmp, "logs") }),
        /symlink/,
      );
    } finally { unlinkSync(dangling); }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("starts a fresh TMP instance on 127.0.0.1:0 and closes idempotently", async () => {
  const tmp = tempRoot();
  const dataDir = join(tmp, "a", "b", "data");
  const logsDir = join(tmp, "a", "b", "logs");
  let f: Awaited<ReturnType<typeof startUnityInstallFixture>> | null = null;
  try {
    f = await startUnityInstallFixture({ dataDir, logsDir, host: "127.0.0.1", port: 0 });
    assert.match(f.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(new URL(f.url).port, "0");
    assert.notEqual(new URL(f.url).port, "7317");
    assert.equal(f.handle.dataDir, dataDir);
    assert.equal(existsSync(join(dataDir, "vault.db")), true);
    assert.equal(existsSync(join(logsDir, "server.log")), true);
    const mcpUrl = f.handle.repo.getSetting("unity_mcp_url") ?? "";
    assert.match(mcpUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.notEqual(new URL(mcpUrl).port, "8080");
    assert.notEqual(new URL(mcpUrl).port, "14523");
    const init = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(init.status, 200);
    const session = init.headers.get("mcp-session-id") ?? "";
    assert.ok(session);
    const list = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": session },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    const listBody = await list.json() as { result?: { tools?: Array<{ name?: string }> } };
    assert.equal(listBody.result?.tools?.[0]?.name, "execute_code");
    const call = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": session },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "execute_code", arguments: { action: "execute", code: "x", safety_checks: true } } }),
    });
    const callBody = await call.json() as { result?: { structuredContent?: { data?: { result?: string } } } };
    assert.match(callBody.result?.structuredContent?.data?.result ?? "", /^\/tmp\/av-unity-fixture-editor\/Assets\|/);
    const res = await fetch(f.url + "/api/health");
    assert.equal(res.status, 200);
    const body = await res.json() as { ok?: boolean };
    assert.equal(body.ok, true);
  } finally {
    if (f) {
      await f.close();
      await f.close();
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fetch guard blocks non-own origins before the underlying fetch", async () => {
  const tmp = tempRoot();
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const sentinel = new Error("underlying fetch reached");
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    throw sentinel;
  }) as typeof fetch;
  let f: Awaited<ReturnType<typeof startUnityInstallFixture>> | null = null;
  try {
    f = await startFixture(tmp, "a");
    await assert.rejects(
      async () => fetch("http://127.0.0.1:1/blocked"),
      /fixture fetch guard blocked origin/,
    );
    assert.deepEqual(calls, []);
  } finally {
    if (f) await f.close();
    globalThis.fetch = originalFetch;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fetch guard allows own app and stub origins and restores after last close", async () => {
  const tmp = tempRoot();
  const originalFetch = globalThis.fetch;
  let f: Awaited<ReturnType<typeof startUnityInstallFixture>> | null = null;
  try {
    f = await startFixture(tmp, "a");
    assert.notEqual(globalThis.fetch, originalFetch);
    const stub = f.handle.repo.getSetting("unity_mcp_url") ?? "";
    assert.equal((await fetch(stub, mcpInit())).status, 200);
    assert.equal((await fetch(f.url + "/api/health")).status, 200);
  } finally {
    if (f) await f.close();
    assert.equal(globalThis.fetch, originalFetch);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fetch guard keeps other fixtures alive and restores only after the last close", async () => {
  const tmp = tempRoot();
  const originalFetch = globalThis.fetch;
  let a: Awaited<ReturnType<typeof startUnityInstallFixture>> | null = null;
  let b: Awaited<ReturnType<typeof startUnityInstallFixture>> | null = null;
  try {
    a = await startFixture(tmp, "a");
    b = await startFixture(tmp, "b");
    assert.notEqual(globalThis.fetch, originalFetch);
    const aStub = a.handle.repo.getSetting("unity_mcp_url") ?? "";
    const bStub = b.handle.repo.getSetting("unity_mcp_url") ?? "";
    assert.equal((await fetch(aStub, mcpInit())).status, 200);
    assert.equal((await fetch(bStub, mcpInit())).status, 200);
    await a.close();
    a = null;
    assert.notEqual(globalThis.fetch, originalFetch);
    assert.equal((await fetch(bStub, mcpInit())).status, 200);
    await assert.rejects(async () => fetch(aStub, mcpInit()), /fixture fetch guard blocked origin/);
    await b.close();
    b = null;
    assert.equal(globalThis.fetch, originalFetch);
  } finally {
    if (a) await a.close();
    if (b) await b.close();
    globalThis.fetch = originalFetch;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fetch guard restores previous fetch when startup fails", async () => {
  const tmp = tempRoot();
  const originalFetch = globalThis.fetch;
  const blocker = createServer((_req, res) => { res.statusCode = 204; res.end(); });
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = blocker.address();
  assert.ok(addr && typeof addr !== "string");
  const port = addr.port;
  try {
    await assert.rejects(
      () => startUnityInstallFixture({ dataDir: join(tmp, "data"), logsDir: join(tmp, "logs"), host: "127.0.0.1", port }),
      /EADDRINUSE|listen|address/i,
    );
    assert.equal(globalThis.fetch, originalFetch);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    globalThis.fetch = originalFetch;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fetch guard does not overwrite a later external fetch replacement", async () => {
  const tmp = tempRoot();
  const originalFetch = globalThis.fetch;
  let f: Awaited<ReturnType<typeof startUnityInstallFixture>> | null = null;
  try {
    f = await startFixture(tmp, "a");
    const replacement = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => originalFetch(input, init)) as typeof fetch;
    globalThis.fetch = replacement;
    await f.close();
    f = null;
    assert.equal(globalThis.fetch, replacement);
  } finally {
    if (f) await f.close();
    globalThis.fetch = originalFetch;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fetch guard blocks production fallback candidates when the first candidate fails", async () => {
  const tmp = tempRoot();
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const sentinel = new Error("underlying fetch reached");
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    throw sentinel;
  }) as typeof fetch;
  let f: Awaited<ReturnType<typeof startUnityInstallFixture>> | null = null;
  try {
    f = await startFixture(tmp, "a");
    const client = new UnityMcp([
      "http://127.0.0.1:1/mcp",
      "http://127.0.0.1:8080/mcp",
      "http://127.0.0.1:14523/mcp",
    ], 1000);
    await assert.rejects(() => client.connect(), /fixture fetch guard blocked origin/);
    assert.deepEqual(calls, []);
  } finally {
    if (f) await f.close();
    globalThis.fetch = originalFetch;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("stub port rejects reserved ports and uses a non-reserved own port", async () => {
  const mod = await import("./unity-install-fixture-server");
  const isReserved = (mod as any).isReservedStubPort;
  assert.equal(typeof isReserved, "function");
  assert.equal(isReserved(7317), true);
  assert.equal(isReserved(8080), true);
  assert.equal(isReserved(14523), true);
  assert.equal(isReserved(0), false);
  assert.equal(isReserved(12345), false);
  const tmp = tempRoot();
  let f: Awaited<ReturnType<typeof startUnityInstallFixture>> | null = null;
  try {
    f = await startFixture(tmp, "a");
    const stub = f.handle.repo.getSetting("unity_mcp_url") ?? "";
    const port = Number(new URL(stub).port);
    assert.equal(isReserved(port), false);
    assert.notEqual(port, 7317);
    assert.notEqual(port, 8080);
    assert.notEqual(port, 14523);
  } finally {
    if (f) await f.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
