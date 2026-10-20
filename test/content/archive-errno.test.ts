/**
 * FIX-03：probeContainer 保留 errno（找不到/目录等），detectContainer 仍返回 null 兼容旧调用。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectContainer, probeContainer } from "../../packages/core/src/archive/list";

test("probeContainer：不存在 → error.code=ENOENT 且 kind=null", () => {
  const dir = mkdtempSync(join(tmpdir(), "av-errno-"));
  try {
    const miss = join(dir, "nope.zip");
    const probe = probeContainer(miss);
    assert.equal(probe.kind, null);
    assert.equal(probe.error?.code, "ENOENT");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("probeContainer：目录 → EISDIR；detectContainer 兼容返回 null", () => {
  const dir = mkdtempSync(join(tmpdir(), "av-errno-dir-"));
  try {
    const probe = probeContainer(dir);
    assert.equal(probe.kind, null);
    assert.ok(probe.error?.code === "EISDIR" || probe.error?.code === "ENOENT");
    assert.equal(detectContainer(dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
