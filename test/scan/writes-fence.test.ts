/**
 * v0.6.1 FIX-07（task-35）：asset/scan 派生写入的作业围栏
 * markAssetsMissing / updateItem / insertScanAssetsBatch 传 fence{jobId,holder,token} 时，
 * SQL 内 EXISTS(jobs) 校验；接管后旧持有者 0 行，新持有者正常。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { openTempDb, addItem, addRoot, addAsset, type TempDb } from "../schema/_db";
import { Repo, type JobFence } from "../../apps/server/src/db/repo";

let t: TempDb; let repo: Repo; let itemId: number; let rootId: number;
beforeEach(() => { t = openTempDb(); repo = new Repo(t.db); itemId = addItem(t.db); rootId = addRoot(t.db, "/lib"); repo.resetScanSeen(); });
afterEach(() => t.close());

function leaseFence(holder = "A", token = 1) {
  const job = repo.createJob("scan", null, { path: "/lib" }, 5);
  t.db.prepare("UPDATE jobs SET holder=?, lease_token=? WHERE id=?").run(holder, token, job.id);
  const fence: JobFence = { jobId: job.id, holder, token };
  return { job, fence };
}
function takeover(fence: JobFence, holder = "B"): JobFence {
  t.db.prepare("UPDATE jobs SET holder=?, lease_token=lease_token+1 WHERE id=?").run(holder, fence.jobId);
  return { jobId: fence.jobId, holder, token: fence.token + 1 };
}

describe("markAssetsMissing 围栏", () => {
  test("旧 token 0 行；新 token 正常标 missing", () => {
    const a = addAsset(t.db, itemId, rootId, "/lib/a.zip");
    const { fence } = leaseFence();
    const next = takeover(fence);
    repo.markAssetsMissing([a], fence);
    assert.notEqual(repo.getAsset(a)!.status, "missing", "旧持有者不得标缺失");
    repo.markAssetsMissing([a], next);
    assert.equal(repo.getAsset(a)!.status, "missing");
  });

  test("无 fence 的用户路径行为不变", () => {
    const a = addAsset(t.db, itemId, rootId, "/lib/b.zip");
    repo.markAssetsMissing([a]);
    assert.equal(repo.getAsset(a)!.status, "missing");
  });
});

describe("updateItem 围栏", () => {
  test("旧 token 不写；新 token 正常写（且旧写不触发 FTS 同步）", () => {
    const item = repo.createItem({ title: "原始标题" });
    const { fence } = leaseFence();
    const next = takeover(fence);
    repo.updateItem(item.id, { title: "旧持有者写入" }, fence);
    assert.equal(repo.getItem(item.id)!.title, "原始标题");
    repo.updateItem(item.id, { title: "新持有者写入" }, next);
    assert.equal(repo.getItem(item.id)!.title, "新持有者写入");
  });

  test("无 fence 的 HTTP/服务路径行为不变", () => {
    const item = repo.createItem({ title: "x" });
    repo.updateItem(item.id, { notes: "manual" });
    assert.equal(repo.getItem(item.id)!.notes, "manual");
  });
});

describe("insertScanAssetsBatch 围栏", () => {
  const count = () => (t.db.prepare("SELECT COUNT(*) c FROM scan_assets").get() as any).c as number;
  test("旧 token 不登记本轮清单；新 token 正常登记 + 幂等", () => {
    const a = addAsset(t.db, itemId, rootId, "/lib/c.zip");
    const b = addAsset(t.db, itemId, rootId, "/lib/d.zip");
    const { fence } = leaseFence();
    const next = takeover(fence);
    repo.insertScanAssetsBatch([a, b], fence);
    assert.equal(count(), 0, "旧持有者不得写 scan_assets");
    repo.insertScanAssetsBatch([a, b], next);
    assert.equal(count(), 2);
    repo.insertScanAssetsBatch([a], next);
    assert.equal(count(), 2, "OR IGNORE 幂等");
  });

  test("无 fence 的直调（诊断/脚本）行为不变", () => {
    const a = addAsset(t.db, itemId, rootId, "/lib/e.zip");
    repo.insertScanAssetsBatch([a]);
    assert.equal(count(), 1);
  });
});
