/**
 * P1-T2：AppError.details 子码（additive）。
 * 约束：fail 仅在 details 为对象时附带 details；无 details 时响应形状与旧版一致。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fail } from "../../apps/server/src/http/routes";
import { AppError } from "../../packages/core/src/contracts";

test("details.code 序列化；无 details 时不出现该键", () => {
  const sent: any = {};
  const reply = { status(c: number) { sent.status = c; return this; }, send(b: any) { sent.body = b; return this; } } as any;
  fail(reply, new AppError("CONFLICT", "x", 409, { code: "PATH_OWNED_BY_OTHER_ITEM" }));
  assert.equal(sent.status, 409);
  assert.deepEqual(sent.body, { error: { code: "CONFLICT", message: "x", details: { code: "PATH_OWNED_BY_OTHER_ITEM" } } });
  fail(reply, new AppError("INVALID_INPUT", "y", 400));
  assert.equal("details" in sent.body.error, false);
});
