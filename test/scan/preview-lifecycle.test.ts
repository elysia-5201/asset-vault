/**
 * v0.6.1 FIX-01（task-30）：预览终态 CAS / 取消丢弃 / 失联清扫 / apply 范围
 * 覆盖：updateScanPreviewIf CAS；被取消后生成结果丢弃；生成失败落 failed；runner 预览异常→preview failed；
 *       sweep（scanning 超时无作业→expired、applying 无作业/死作业→failed、apply_runs running 死作业→failed、在飞保护）；
 *       missing-only apply（files=[]）不遍历目录、不新增资产、只按 markMissing 标记。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTempDb, addItem, addRoot, addAsset, addJob, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { generateScanPreview } from "../../apps/server/src/services/scanpreview";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";
import { runJob, type JobDeps } from "../../apps/server/src/jobs/runner";
import { normalizePath } from "../../packages/core/src/pathnorm";

let t: TempDb; let repo: Repo; let itemId: number; let rootId: number;
beforeEach(() => { t = openTempDb(); repo = new Repo(t.db); itemId = addItem(t.db); rootId = addRoot(t.db, "/lib"); });
afterEach(() => t.close());

const past = () => "2020-01-01T00:00:00.000Z";
const preview = (path = "/lib/scan") => repo.createScanPreview({ rootId, path, deep: false });
const mkScanJob = (previewId: number) => repo.createJob("scan", null, { mode: "preview", previewId, path: "/lib/scan" }, 5);
const markDone = (jobId: number) => t.db.prepare("UPDATE jobs SET state='done', finished_at=? WHERE id=?").run(new Date().toISOString(), jobId);

describe("updateScanPreviewIf：CAS 终态", () => {
  test("只有期望状态才写；已 cancelled 的预览不再接受 ready", () => {
    const p = preview();
    const ready = repo.updateScanPreviewIf(p.id, ["scanning"], { state: "ready", files: 1 });
    assert.ok(ready);
    assert.equal(ready.state, "ready");
    assert.equal(repo.updateScanPreviewIf(p.id, ["scanning"], { state: "partial" }), null);
    assert.equal(repo.getScanPreview(p.id).state, "ready");
    assert.ok(repo.updateScanPreviewIf(p.id, ["ready"], { state: "cancelled" }));
    assert.equal(repo.updateScanPreviewIf(p.id, ["scanning", "ready"], { state: "ready" }), null);
  });
});

describe("生成结果丢弃", () => {
  test("预览被取消后，generateScanPreview 不写条目、不覆盖 cancelled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "av-fix01-gen-"));
    try {
      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(join(dir, "sub", "a.zip"), Buffer.alloc(4, 1));
      const p = repo.createScanPreview({ rootId, path: dir, deep: false });
      assert.ok(repo.updateScanPreviewIf(p.id, ["scanning"], { state: "cancelled" }));
      const r = await generateScanPreview(repo, p.id);
      assert.equal(r.state, "cancelled");
      assert.equal(repo.getScanPreview(p.id).state, "cancelled");
      assert.equal(repo.scanPreviewItemCounts(p.id).total, 0, "被取消后不得落条目");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("直接调用 generate 遇不可读根会抛错且不伪造终态（runner 负责落 failed）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "av-fix01-gone-"));
    const p = repo.createScanPreview({ rootId, path: join(dir, "missing"), deep: false });
    await assert.rejects(() => generateScanPreview(repo, p.id));
    // 直接调用不是生产路径：状态仍 scanning，由 runner 的 try/catch 或 sweep 收尾（下一条测试覆盖）
    assert.equal(repo.getScanPreview(p.id).state, "scanning");
    rmSync(dir, { recursive: true, force: true });
  });

  test("runner 预览异常（路径不存在）→ job failed 且 preview failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "av-fix01-run-"));
    const p = repo.createScanPreview({ rootId, path: join(dir, "nope"), deep: false });
    const job = repo.createJob("scan", null, { mode: "preview", previewId: p.id, path: join(dir, "nope") }, 5);
    const deps: JobDeps = { repo, media: {} as any, booth: {} as any, log: () => {}, limits: resolveLimits({}) };
    await runJob(deps, job.id);
    assert.equal(repo.getJob(job.id)!.state, "failed");
    assert.equal(repo.getScanPreview(p.id).state, "failed");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("失联清扫 sweep", () => {
  test("scanning 过期且无在飞 job → expired；有在飞 job 则保留", () => {
    const p1 = preview("/lib/a"); repo.updateScanPreview(p1.id, { expires_at: past() });
    const p2 = preview("/lib/b"); repo.updateScanPreview(p2.id, { expires_at: past() });
    const j = mkScanJob(p2.id); // queued=active
    const n = repo.expireScanPreviews();
    assert.ok(n >= 1);
    assert.equal(repo.getScanPreview(p1.id).state, "expired");
    assert.equal(repo.getScanPreview(p2.id).state, "scanning", "有在飞生成 job 不得判死");
    assert.equal(repo.getJob(j.id)!.state, "queued");
  });

  test("applying 无 apply_job_id / job 已死 → failed；job 在飞则保留", () => {
    const a = preview("/lib/c"); repo.updateScanPreview(a.id, { state: "applying" });
    const b = preview("/lib/d"); const bj = mkScanJob(b.id); markDone(bj.id); repo.updateScanPreview(b.id, { state: "applying", apply_job_id: bj.id });
    const c = preview("/lib/e"); const cj = mkScanJob(c.id); repo.updateScanPreview(c.id, { state: "applying", apply_job_id: cj.id });
    repo.expireScanPreviews();
    assert.equal(repo.getScanPreview(a.id).state, "failed");
    assert.equal(repo.getScanPreview(b.id).state, "failed");
    assert.equal(repo.getScanPreview(c.id).state, "applying", "在飞应用不得被判死");
  });

  test("apply_runs running 且 job 缺失/已死 → failed；在飞则保留", () => {
    const p = preview("/lib/f"); repo.updateScanPreview(p.id, { state: "applying" });
    const dead = mkScanJob(p.id); markDone(dead.id);
    const r1 = repo.createScanApplyRun({ previewId: p.id, requested: 1, jobId: dead.id, idempotencyKey: "k1" });
    const r2 = repo.createScanApplyRun({ previewId: p.id, requested: 1, jobId: null, idempotencyKey: "k2" });
    const live = mkScanJob(p.id);
    const r3 = repo.createScanApplyRun({ previewId: p.id, requested: 1, jobId: live.id, idempotencyKey: "k3" });
    repo.updateScanPreview(p.id, { apply_job_id: live.id });
    repo.expireScanPreviews();
    assert.equal(repo.getScanApplyRun(r1.id).state, "failed");
    assert.equal(repo.getScanApplyRun(r2.id).state, "failed");
    assert.equal(repo.getScanApplyRun(r3.id).state, "running");
  });
});

describe("取消生成中的 job（路由语义）", () => {
  test("findActiveJobByPreview 找到 queued 生成 job；stop→cancel_apply 后 CAS 预览 cancelled，迟到结果被拒", () => {
    const p = preview("/lib/cancel");
    const job = mkScanJob(p.id);
    const active = repo.findActiveJobByPreview(p.id);
    assert.equal(active?.id, job.id);
    const stopped = repo.transitionJob(job.id, "stop");
    assert.equal(stopped.state, "releasing");
    const cancelled = repo.transitionJob(job.id, "cancel_apply");
    assert.equal(cancelled.state, "cancelled");
    assert.ok(repo.updateScanPreviewIf(p.id, ["scanning"], { state: "cancelled" }));
    // 生成器迟到：scanning CAS 不再命中 → 结果丢弃
    assert.equal(repo.updateScanPreviewIf(p.id, ["scanning"], { state: "ready" }), null);
    assert.equal(repo.findActiveJobByPreview(p.id), null);
  });
});

describe("apply 范围（AUD-08）", () => {
  test("missing-only（files=[]）不遍历目录：只标记 missing，不登记目录里的其它文件", async () => {
    const dir = mkdtempSync(join(tmpdir(), "av-fix01-apply-"));
    try {
      // 目录里有两个真实 zip，但用户只确认一个 missing
      writeFileSync(join(dir, "on-disk-1.zip"), Buffer.alloc(4, 1));
      writeFileSync(join(dir, "on-disk-2.zip"), Buffer.alloc(4, 2));
      const gonePath = join(dir, "gone.zip");
      const a = addAsset(t.db, itemId, rootId, gonePath);
      const before = (t.db.prepare("SELECT COUNT(*) c FROM assets WHERE status<>'trashed'").get() as any).c;
      const p = repo.createScanPreview({ rootId, path: dir, deep: false });
      repo.replaceScanPreviewItems(p.id, [{ path: gonePath, path_norm: normalizePath(gonePath), change: "missing", assetId: a }]);
      const item = (repo.listScanPreviewItems(p.id, { limit: 10 }).items[0]) as any;
      repo.updateScanPreview(p.id, { state: "applying" });
      const run = repo.createScanApplyRun({ previewId: p.id, requested: 1 });
      const job = repo.createJob("scan", null, {
        mode: "apply", previewId: p.id, applyRunId: run.id, path: dir, rootId, deep: false,
        files: [], markMissing: [a], applyItems: [{ id: item.id, pathNorm: normalizePath(gonePath), change: "missing" }], staleCount: 0,
      }, 5);
      repo.updateScanApplyRun(run.id, { job_id: job.id });
      repo.updateScanPreview(p.id, { apply_job_id: job.id });
      const deps: JobDeps = { repo, media: {} as any, booth: {} as any, log: () => {}, limits: resolveLimits({ maxScanFiles: 10, registerBatchSize: 10 }) };
      await runJob(deps, job.id);
      assert.equal(repo.getJob(job.id)!.state, "done");
      assert.equal(repo.getAsset(a)!.status, "missing");
      const after = (t.db.prepare("SELECT COUNT(*) c FROM assets WHERE status<>'trashed'").get() as any).c;
      assert.equal(after, before, "missing-only apply 不得把目录里的文件登记成新资产");
      assert.equal(repo.getScanPreview(p.id).state, "applied");
      assert.equal(repo.getScanApplyRun(run.id).state, "done");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
