/**
 * ApiError.details 与 describeError 子码（P1-T4）。
 * 目标：details 不只在构造器保存；request() 的真实错误分支必须把服务端 error.details 原样带出。
 * 说明：brief 示例第 3 断言写 "x"，与 dispatch「保持旧 describeError 对其它既有 error 兼容」冲突；
 *       按最小裁定保留旧输出（INVALID_INPUT：x），见 task-4-report.md 的 Ruling。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, describeError, patchItem } from "../../apps/web/src/api";

test("ApiError 保留 details.code，describeError 带子码", () => {
  const e = new ApiError("CONFLICT", "路径已被占用", 409, { code: "PATH_OWNED_BY_OTHER_ITEM" });
  assert.equal(e.details?.code, "PATH_OWNED_BY_OTHER_ITEM");
  assert.equal(describeError(e), "路径已被占用（PATH_OWNED_BY_OTHER_ITEM）");
  // 旧 3 参调用兼容；无 details 时保持既有输出（旧 helper 语义不弱化）
  assert.equal(describeError(new ApiError("INVALID_INPUT", "x", 400)), "INVALID_INPUT：x");
});

test("request() 错误分支把服务端 error.details 原样传给 ApiError（closed fetch stub）", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({
      error: {
        code: "CONFLICT",
        message: "路径已被占用",
        details: { code: "PATH_OWNED_BY_OTHER_ITEM", itemId: 7, assetId: 9 },
      },
    }), { status: 409, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await assert.rejects(patchItem(1, {}), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, "CONFLICT");
      assert.equal(err.status, 409);
      const d = err.details as { code?: string; itemId?: number; assetId?: number } | undefined;
      assert.equal(d?.code, "PATH_OWNED_BY_OTHER_ITEM");
      // 原样传：附加字段不被重建丢弃
      assert.equal(d?.itemId, 7);
      assert.equal(d?.assetId, 9);
      assert.equal(describeError(err), "路径已被占用（PATH_OWNED_BY_OTHER_ITEM）");
      return true;
    });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
