/**
 * v0.6.0 流水线契约测试 —— limits（verifier）
 * 覆盖：DEFAULT_LIMITS 冻结、resolveLimits 的 clamp/例外/忽略规则、limitsHash 稳定性、nonDefaultLimits。
 * 实现：apps/server/src/services/pipeline/limits.ts（不改实现，只钉契约）
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, resolveLimits, limitsHash, nonDefaultLimits, type PipelineLimits } from "../../apps/server/src/services/pipeline/limits";

const numericKeys = Object.keys(DEFAULT_LIMITS) as (keyof PipelineLimits)[];

describe("DEFAULT_LIMITS", () => {
  test("冻结（不可被调用方改写）", () => {
    assert.equal(Object.isFrozen(DEFAULT_LIMITS), true);
  });
  test("关键默认值与文档一致", () => {
    assert.equal(DEFAULT_LIMITS.maxScanFiles, 20000);
    assert.equal(DEFAULT_LIMITS.scanMaxDepth, 6);
    assert.equal(DEFAULT_LIMITS.scanDeepMaxDepth, 10);
    assert.equal(DEFAULT_LIMITS.maxArchiveEntries, 20000);
    assert.equal(DEFAULT_LIMITS.taskMaxAttempts, 3);
    assert.equal(DEFAULT_LIMITS.maxNestedDepth, 1);
    assert.equal(DEFAULT_LIMITS.queueHighWater, 2000);
    assert.equal(DEFAULT_LIMITS.queueLowWater, 500);
    assert.equal(DEFAULT_LIMITS.cacheMaxBytes, 2 * 1024 * 1024 * 1024);
    assert.equal(numericKeys.length, 37, "默认值键数（新增键时同步更新本断言）");
    for (const k of numericKeys) assert.equal(typeof DEFAULT_LIMITS[k], "number", k + " 必须是 number");
  });
});

describe("resolveLimits：默认与容错", () => {
  test("undefined / null / 非对象 → 全默认（深比较）", () => {
    for (const raw of [undefined, null, 42, "x", [], true]) assert.deepEqual(resolveLimits(raw), { ...DEFAULT_LIMITS });
  });
  test("空对象 → 全默认", () => {
    assert.deepEqual(resolveLimits({}), { ...DEFAULT_LIMITS });
  });
  test("未知键忽略、非数字不采纳（NaN/Infinity/字符串/布尔）", () => {
    const r = resolveLimits({ hashConcurrency: NaN, archiveConcurrency: Infinity, xyz: 5, maxScanFiles: "100", maxScanFiles2: true, thumbConcurrency: -Infinity });
    assert.equal(r.hashConcurrency, DEFAULT_LIMITS.hashConcurrency);
    assert.equal(r.archiveConcurrency, DEFAULT_LIMITS.archiveConcurrency);
    assert.equal(r.maxScanFiles, DEFAULT_LIMITS.maxScanFiles);
    assert.equal(r.thumbConcurrency, DEFAULT_LIMITS.thumbConcurrency);
    assert.equal((r as any).xyz, undefined);
  });
  test("下限 clamp：普通数字最小 1", () => {
    assert.equal(resolveLimits({ hashConcurrency: 0 }).hashConcurrency, 1);
    assert.equal(resolveLimits({ hashConcurrency: -5 }).hashConcurrency, 1);
    assert.equal(resolveLimits({ taskMaxAttempts: 0 }).taskMaxAttempts, 1);
    assert.equal(resolveLimits({ queueHighWater: -1 }).queueHighWater, 1);
  });
  test("例外：maxNestedDepth 允许 0、maxCompressionRatio 最小 1", () => {
    assert.equal(resolveLimits({ maxNestedDepth: 0 }).maxNestedDepth, 0);
    assert.equal(resolveLimits({ maxNestedDepth: -3 }).maxNestedDepth, 0, "maxNestedDepth 的下限是 0（负数 clamp 到 0）");
    assert.equal(resolveLimits({ maxCompressionRatio: -5 }).maxCompressionRatio, 1, "maxCompressionRatio 的下限是 1");
    assert.equal(resolveLimits({ maxCompressionRatio: 0 }).maxCompressionRatio, 1);
    assert.equal(resolveLimits({ maxCompressionRatio: 1 }).maxCompressionRatio, 1);
  });
  test("上限 clamp 与取整", () => {
    assert.equal(resolveLimits({ taskMaxAttempts: 99 }).taskMaxAttempts, 10);
    assert.equal(resolveLimits({ maxNestedDepth: 99 }).maxNestedDepth, 8);
    assert.equal(resolveLimits({ queueHighWater: 2_000_000 }).queueHighWater, 1_000_000);
    assert.equal(resolveLimits({ hashConcurrency: 2.9 }).hashConcurrency, 2);
    assert.equal(resolveLimits({ registerBatchSize: 0.9 }).registerBatchSize, 1);
  });
  test("只覆盖传入的键，其余保持默认（正/反例对照）", () => {
    const r = resolveLimits({ hashConcurrency: 5 });
    assert.equal(r.hashConcurrency, 5);                       // 正例：改了
    assert.equal(r.archiveConcurrency, DEFAULT_LIMITS.archiveConcurrency); // 反例：没被连带改
  });
});

describe("limitsHash", () => {
  test("同值稳定；键顺序无关", () => {
    const reversed = Object.fromEntries(Object.entries(DEFAULT_LIMITS).reverse()) as unknown;
    assert.equal(limitsHash(resolveLimits(DEFAULT_LIMITS)), limitsHash(resolveLimits(reversed)), "全默认：顺序无关");
    const raw1 = { hashConcurrency: 5, archiveConcurrency: 2, thumbConcurrency: 7 };
    const raw2 = { thumbConcurrency: 7, archiveConcurrency: 2, hashConcurrency: 5 };
    assert.equal(limitsHash(resolveLimits(raw1)), limitsHash(resolveLimits(raw2)), "部分覆盖：顺序无关");
    assert.equal(limitsHash(DEFAULT_LIMITS), limitsHash(DEFAULT_LIMITS), "自身稳定");
  });
  test("任一值变化 → 哈希变化（全键逐一验证）", () => {
    const base = limitsHash(DEFAULT_LIMITS);
    for (const k of numericKeys) {
      const v = DEFAULT_LIMITS[k];
      const changed = resolveLimits({ [k]: v === 1 ? 2 : v + 1 });
      assert.notEqual(limitsHash(changed), base, "改 " + k + " 后哈希未变");
    }
  });
  test("哈希形状：16 位 hex（用于缓存键）", () => {
    assert.match(limitsHash(DEFAULT_LIMITS), /^[a-f0-9]{16}$/);
  });
});

describe("nonDefaultLimits", () => {
  test("全默认 → 空对象", () => {
    assert.deepEqual(nonDefaultLimits({ ...DEFAULT_LIMITS }), {});
  });
  test("只列出改动项（含被 clamp 后的值）", () => {
    const r = resolveLimits({ hashConcurrency: 5, taskMaxAttempts: 99 });
    const nd = nonDefaultLimits(r);
    assert.deepEqual(nd, { hashConcurrency: 5, taskMaxAttempts: 10 });
  });
});
