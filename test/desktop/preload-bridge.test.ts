/**
 * Desktop 窄路径桥（preload.cjs）行为测试。
 *
 * 用 node:vm + 假 electron 模块加载真实 preload.cjs：不启动 Electron、不碰真实文件系统。
 * 隔离的桌面桥：获取拖入文件路径，或以包内文件引用和不透明令牌请求拖出文件。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const preloadPath = join(here, "..", "..", "apps", "desktop", "preload.cjs");

interface FakeWebUtils { getPathForFile: (f: unknown) => string }

function loadPreload(webUtils: FakeWebUtils) {
  const calls: Array<{ key: string; api: Record<string, unknown> }> = [];
  const required: string[] = [];
  const invoked: [string, unknown][] = [];
  const fakeElectron = {
    contextBridge: {
      exposeInMainWorld: (key: string, api: Record<string, unknown>) => { calls.push({ key, api }); },
    },
    ipcRenderer: { invoke: (channel: string, value: unknown) => {
      invoked.push([channel, value]);
      return Promise.resolve(channel === "archive-drag:prepare" ? { token: "fixture-token" } : { ok: true });
    } },
    webUtils,
  };
  const require = (id: string) => {
    required.push(id);
    if (id === "electron") return fakeElectron;
    throw new Error("preload must not require: " + id);
  };
  const code = readFileSync(preloadPath, "utf8");
  const module = { exports: {} as Record<string, unknown> };
  const sandbox = { require, module, exports: module.exports, console };
  vm.runInNewContext(code, sandbox, { filename: preloadPath });
  return { calls, required, invoked };
}

test("preload：只暴露固定的桌面操作", () => {
  const { calls, required } = loadPreload({ getPathForFile: () => "C:\\x\\a.zip" });
  assert.equal(calls.length, 1, "exposeInMainWorld 必须恰好调用一次");
  assert.equal(calls[0]?.key, "assetVaultDesktop");
  const api = calls[0]?.api ?? {};
  assert.deepEqual(Object.keys(api), ["getPathForFile", "prepareArchiveDrag", "startArchiveDrag", "chooseImportFolder"]);
  assert.equal(typeof api.getPathForFile, "function");
  assert.deepEqual(required, ["electron"], "preload 只能 require electron");
});

test("preload：把包内引用和令牌发往固定的拖出通道", async () => {
  const { calls, invoked } = loadPreload({ getPathForFile: () => "" });
  const bridge = calls[0]!.api as {
    prepareArchiveDrag: (entry: unknown) => Promise<{ token: string }>;
    startArchiveDrag: (token: string) => Promise<{ ok: boolean }>;
  };
  const ref = { assetId: 10, nested: "extra.zip", entryPath: "texture/Body.psd" };
  const { token } = await bridge.prepareArchiveDrag(ref);
  assert.equal((await bridge.startArchiveDrag(token)).ok, true);
  assert.deepEqual(invoked, [["archive-drag:prepare", ref], ["archive-drag:start", "fixture-token"]]);
});

test("preload：getPathForFile 透传 webUtils 返回值", () => {
  const { calls } = loadPreload({ getPathForFile: (f) => "C:\\lib\\" + String((f as { name?: string })?.name ?? "?") });
  const api = calls[0]!.api as { getPathForFile: (f: unknown) => string | null };
  assert.equal(api.getPathForFile({ name: "a.zip" }), "C:\\lib\\a.zip");
});

test("preload：webUtils 抛错 → null，不向渲染进程抛", () => {
  const { calls } = loadPreload({ getPathForFile: () => { throw new Error("boom"); } });
  const api = calls[0]!.api as { getPathForFile: (f: unknown) => string | null };
  assert.equal(api.getPathForFile({ name: "a.zip" }), null);
});

test("preload：webUtils 返回空串 → null（虚拟/截图 File 不伪造路径）", () => {
  const { calls } = loadPreload({ getPathForFile: () => "" });
  const api = calls[0]!.api as { getPathForFile: (f: unknown) => string | null };
  assert.equal(api.getPathForFile({ name: "screenshot.png" }), null);
});
