/**
 * N2 关联/版本动作的 typed 客户端与挂载静态门（Ruling19）。
 *
 * 关闭网络：fetch 被 stub，只断言真实 wrapper 发出的 method/url/body 与错误 details；
 * 另用源码静态断言确认 ImportPanel 走 expected 安全登记（不是 unsafe addAsset、不提交原目录），
 * ItemDetail 真实挂载版本关系与加入清单，App 真实传 onOpenItem/onOpenLoadouts。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiError, addAsset, addAssetWithExpected } from "../../apps/web/src/api";

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

const EXPECTED = { size: 123, mtime: "2026-11-04T02:00:00.000Z", sha256: "a".repeat(64) };

test("addAssetWithExpected 只发单个文件 + expected，不回传目录 paths", async () => {
  const stub = stubFetch(() => json({ added: 1, assetIds: [42] }));
  try {
    const res = await addAssetWithExpected(7, "C:/Downloads/a.zip", EXPECTED);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].method, "POST");
    assert.equal(stub.calls[0].url, "/api/items/7/assets");
    assert.deepEqual(stub.calls[0].body, { path: "C:/Downloads/a.zip", expected: EXPECTED });
    const body = stub.calls[0].body as Record<string, unknown>;
    assert.equal("paths" in body, false);
    assert.equal("downloadRoot" in body, false);
    assert.deepEqual(res, { added: 1, assetIds: [42] });
  } finally { stub.restore(); }
});

test("addAssetWithExpected 透出 409 子码与 details（陈旧 / 跨 owner），不吞错误", async () => {
  const stale = stubFetch(() => json({ error: { code: "CONFLICT", message: "precheck stale", details: { code: "PRECHECK_STALE" } } }, 409));
  try {
    await assert.rejects(addAssetWithExpected(7, "C:/Downloads/a.zip", EXPECTED), (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 409);
      assert.equal(e.code, "CONFLICT");
      assert.equal(e.details?.code, "PRECHECK_STALE");
      return true;
    });
  } finally { stale.restore(); }

  const foreign = stubFetch(() => json({
    error: { code: "CONFLICT", message: "path owned by item 9", details: { code: "PATH_OWNED_BY_OTHER_ITEM", itemId: 9, assetId: 33 } },
  }, 409));
  try {
    await assert.rejects(addAssetWithExpected(7, "C:/Downloads/a.zip", EXPECTED), (e: unknown) => {
      assert.ok(e instanceof ApiError);
      const d = e.details as unknown as { code?: string; itemId?: number; assetId?: number };
      assert.equal(d.code, "PATH_OWNED_BY_OTHER_ITEM");
      assert.equal(d.itemId, 9);
      assert.equal(d.assetId, 33);
      return true;
    });
  } finally { foreign.restore(); }
});

test("legacy addAsset 请求体不变（只带 path）", async () => {
  const stub = stubFetch(() => json({ added: 1, assetIds: [1] }));
  try {
    await addAsset(7, "C:/Downloads/a.zip");
    assert.deepEqual(stub.calls[0].body, { path: "C:/Downloads/a.zip" });
  } finally { stub.restore(); }
});

const read = (rel: string): string => readFileSync(fileURLToPath(new URL("../../apps/web/src/" + rel, import.meta.url)), "utf8");

test("ImportPanel 关联走 expected 安全登记：不用 unsafe addAsset、不提交原目录", () => {
  const src = read("components/ImportPanel.tsx");
  assert.ok(src.includes("addAssetWithExpected"), "关联必须走带 expected 的 wrapper");
  assert.equal(/\baddAsset\(/.test(src), false, "不得调用 legacy addAsset（无 expected 的 unsafe 登记）");
  assert.ok(src.includes("addAssetWithExpected(target, row.path, exp)"), "只提交当前行单个文件 + 该行 expected");
  assert.ok(src.includes("expectedOf(row)"), "expected 必须来自预检行真实元数据");
  assert.ok(src.includes("props.onOpenItem?.(assoc.done!.itemId)"), "登记后必须能打开真实条目建版本关系");
  assert.ok(src.includes("关联到既有条目"), "必须有用户显式选择既有条目的入口");
});

test("ItemDetail 真实挂载版本关系与加入清单；App 真实传回调与两个面板入口", () => {
  const detail = read("components/ItemDetail.tsx");
  assert.ok(detail.includes("<VersionLinksSection"), "ItemDetail 必须挂载版本关系面板");
  assert.ok(detail.includes("<AddToLoadoutButton"), "ItemDetail 必须挂载加入清单按钮");
  assert.ok(detail.includes("selectedAvatarId"), "加入清单的模型来自父传入的显式选择");

  const app = read("App.tsx");
  assert.ok(app.includes("onOpenItem={setSelectedItemId}"), "ImportPanel 必须拿到真实 onOpenItem");
  assert.ok(app.includes("整理待办"), "更多工具必须有整理待办入口");
  assert.ok(app.includes("<CleanupPanel"), "整理待办面板必须真实渲染");
  assert.ok(app.includes("<LoadoutPanel"), "搭配清单面板必须真实渲染");
  assert.ok(app.includes("onOpenLoadouts={openLoadouts}"), "头像轨必须拿到搭配入口");

  const rail = read("components/AvatarRail.tsx");
  assert.ok(rail.includes("onOpenLoadouts"), "AvatarRail 必须提供搭配入口");
});
