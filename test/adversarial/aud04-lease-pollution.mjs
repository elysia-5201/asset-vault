/**
 * AUD-04 租约污染对抗（verifier / task-25 + FIX-02 回归 / task-32 后续）
 * 运行：node --import tsx test/adversarial/aud04-lease-pollution.mjs
 * 全部使用 os.tmpdir() 的一次性库；不触碰 data/vault.db。
 *
 * 覆盖（v7 围栏语义）：
 *   [A] jobs 状态/事件/续租：旧持有者迟到写入必须被拒
 *   [B] index_tasks 进度/终态/重试：旧 worker 必须被 owner+lease_token 围栏拒绝
 *   [C] asset/scan 数据写入：FIX-02 未覆盖 → 记录残余风险
 *   [D] reap 与 heartbeat 同到期窗口（不变量：不能同时成功）
 *   [E] 多任务并发领取 + 单条接管
 *   [F] reap 重置子任务（v7 新增）：作业被回收时其 running 子任务回 queued + 换租约
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../apps/server/src/db/migrate.ts";
import { Repo, LeaseLostError } from "../../apps/server/src/db/repo.ts";
import { addItem, addAsset, addRoot } from "../schema/_db.ts";

const dir = mkdtempSync(join(tmpdir(), "av-aud04-"));
const iso = (ms) => new Date(ms).toISOString();
const base = Date.parse("2026-10-20T10:00:00.000Z");
let pass = 0, gaps = 0;
const check = (id, name, ok, extra = "") => {
  if (ok) pass++; else gaps++;
  console.log((ok ? "  ✓ " : "  ✗ GAP ") + id + " " + name + (extra ? " — " + extra : ""));
};

function seed(file) {
  const db = openDatabase(file);
  const repo = new Repo(db);
  const root = addRoot(db, "/aud04");
  const item = addItem(db, { uid: "u-aud04-" + Math.random().toString(36).slice(2) });
  const asset = addAsset(db, item, root, "/aud04/a-" + Math.random().toString(36).slice(2) + ".zip");
  return { db, repo, root, item, asset };
}

// ============ A. jobs 状态/事件/续租 ============
console.log("\n[A] jobs 围栏（预期 PASS）");
{
  const f = join(dir, "jobs.db"); const s = seed(f);
  const job = s.repo.createJob("scan", null, { path: "/aud04" });
  const T = iso(base);
  const la = s.repo.claimNextJob("A", { leaseMs: 1000, now: T });
  check("A-1", "A 领取 job（token=1）", la && Number(la.lease_token) === 1);
  const reaped = s.repo.reapExpiredLeases({ now: iso(base + 1001), reason: "lease expired" });
  const lb = s.repo.claimNextJob("B", { leaseMs: 1000, now: iso(base + 2000) });
  let lost = null;
  try { s.repo.transitionJob(job.id, "resolve_ok", undefined, { holder: "A", token: Number(la.lease_token) }); } catch (e) { lost = e; }
  check("A-2", "reap 后 B 接管；A 的 transitionJob → 409 且状态不变",
    reaped === 1 && lb && Number(lb.lease_token) === Number(la.lease_token) + 2 &&
    lost instanceof LeaseLostError && lost.status === 409 && s.repo.getJob(job.id).state === "resolving");
  const before = s.repo.listJobEvents(job.id).length;
  const logged = s.repo.logJobEvent(job.id, null, "resolving", "late_event", "from A", { holder: "A", token: Number(la.lease_token) });
  check("A-3", "A 的 logJobEvent 被拒且不落事件", logged === false && s.repo.listJobEvents(job.id).length === before);
  const renewed = s.repo.renewLease(job.id, { holder: "A", token: Number(la.lease_token) }, { now: iso(base + 3000) });
  check("A-4", "A 的 renewLease 被拒", renewed === false);
  s.db.close();
}

// ============ B. index_tasks：进度/终态/重试（v7 owner+token 围栏） ============
console.log("\n[B] index_tasks 围栏（FIX-02 目标）");
{
  const f = join(dir, "tasks.db"); const s = seed(f);
  const ra = s.repo;
  const rb = new Repo(openDatabase(f));

  ra.enqueueIndexTask({ assetId: s.asset, stage: "hash" });
  const a1 = ra.claimIndexTask("hash", "A");
  check("B-1a", "A 领取 task（running, owner=A）", a1 && a1.state === "running" && a1.owner === "A", JSON.stringify({ id: a1 && a1.id, owner: a1 && a1.owner, token: a1 && a1.lease_token }));
  const tokA1 = Number(a1.lease_token);
  rb.recoverIndexTasks();
  const b1 = rb.claimIndexTask("hash", "B");
  check("B-1b", "recover 后 B 接管（owner=B, token+1）", b1 && b1.id === a1.id && b1.owner === "B" && Number(b1.lease_token) > tokA1, JSON.stringify({ id: b1 && b1.id, owner: b1 && b1.owner, token: b1 && b1.lease_token }));
  const okUpd = ra.updateIndexTask(a1.id, { bytesDone: 111, bytesTotal: 222, error: "stale-writer" }, { owner: "A", leaseToken: tokA1 });
  const t1 = rb.getIndexTask(a1.id);
  check("B-1c", "旧 worker updateIndexTask 被拒（返回 false、无写入）", okUpd === false && Number(t1.bytes_done) !== 111 && t1.error === null, "ret=" + okUpd + " bytes_done=" + t1.bytes_done);

  ra.enqueueIndexTask({ assetId: s.asset, stage: "archive" });
  const a2 = ra.claimIndexTask("archive", "A");
  const tokA2 = Number(a2.lease_token);
  rb.recoverIndexTasks();
  const b2 = rb.claimIndexTask("archive", "B");
  const oldFinish = ra.finishIndexTask(a2.id, "failed", { errorCode: "OLD", error: "old verdict" }, { requireRunning: true, owner: "A", leaseToken: tokA2 });
  check("B-2a", "旧 worker 终态写入被拒（null，任务仍 running 且归 B）", oldFinish === null && rb.getIndexTask(a2.id).state === "running" && rb.getIndexTask(a2.id).owner === "B", "ret=" + oldFinish);
  const newFinish = rb.finishIndexTask(b2.id, "done", {}, { requireRunning: true, owner: "B", leaseToken: Number(b2.lease_token) });
  check("B-2b", "接管者写终态成功（done）", newFinish && newFinish.state === "done");
  const lateAgain = ra.finishIndexTask(a2.id, "failed", { errorCode: "OLD", error: "old verdict late" }, { requireRunning: true, owner: "A", leaseToken: tokA2 });
  check("B-2c", "旧 failed 在 done 之后仍不能覆盖", lateAgain === null && rb.getIndexTask(a2.id).state === "done");

  ra.enqueueIndexTask({ assetId: s.asset, stage: "thumbs" });
  const a3 = ra.claimIndexTask("thumbs", "A");
  const tokA3 = Number(a3.lease_token);
  rb.recoverIndexTasks();
  const b3 = rb.claimIndexTask("thumbs", "B");
  const oldRetry = ra.retryIndexTask(a3.id, { errorCode: "OLD", error: "old retry", backoffMs: 60000 }, { owner: "A", leaseToken: tokA3 });
  const t3 = rb.getIndexTask(a3.id);
  check("B-3", "旧 worker retryIndexTask 被拒（null，仍 running/owner=B）", oldRetry === null && t3.state === "running" && t3.owner === "B", "ret=" + oldRetry + " state=" + t3.state);
  s.db.close(); rb.db.close?.();
}

// ============ C. asset/scan 数据写入（FIX-07 JobFence） ============
console.log("\n[C] assets/scan 围栏（FIX-07：旧持有者 JobFence 写入必须 0 行）");
{
  const f = join(dir, "assets.db"); const s = seed(f);
  const job = s.repo.createJob("scan", null, { path: "/aud04" });
  const la = s.repo.claimNextJob("A", { leaseMs: 1000, now: iso(base) });
  const fenceOld = { jobId: job.id, holder: "A", token: Number(la.lease_token) };
  s.repo.reapExpiredLeases({ now: iso(base + 1001) });
  const lb = s.repo.claimNextJob("B", { leaseMs: 1000, now: iso(base + 2000) });
  const fenceNew = { jobId: job.id, holder: "B", token: Number(lb.lease_token) };
  const countScanAssets = () => { const row = s.db.prepare("SELECT COUNT(*) c FROM scan_assets").get() || {}; return Number(row.c ?? 0); };
  s.repo.markAssetsMissing([s.asset], fenceOld);
  check("C-1", "旧 runner markAssetsMissing(JobFence) 被拒（0 行）", s.repo.getAsset(s.asset).status !== "missing", "status=" + s.repo.getAsset(s.asset).status);
  s.repo.updateItem(s.item, { title: "STALE-TITLE" }, fenceOld);
  check("C-2", "旧 runner updateItem(JobFence) 被拒", !String(s.repo.getItem(s.item).title).includes("STALE-TITLE"), "title=" + s.repo.getItem(s.item).title);
  s.repo.resetScanSeen();
  s.repo.insertScanAssetsBatch([s.asset], fenceOld);
  check("C-3", "旧 runner insertScanAssetsBatch(JobFence) 被拒（0 行）", countScanAssets() === 0, "scan_assets=" + countScanAssets());
  // 正例对照：新持有者同 fence 应写入成功（证明 fence 不是一味拒绝）
  s.repo.markAssetsMissing([s.asset], fenceNew);
  s.repo.insertScanAssetsBatch([s.asset], fenceNew);
  check("C-4", "新持有者 JobFence 写入成功（正例对照）", s.repo.getAsset(s.asset).status === "missing" && countScanAssets() === 1, "status=" + s.repo.getAsset(s.asset).status + " scan_assets=" + countScanAssets());
  s.db.close();
}

// ============ D. reap 与 heartbeat 同到期窗口 ============
console.log("\n[D] reap × heartbeat 同窗口（不变量：不能同时成功）");
for (const ms of [999, 1000, 1001]) {
  const f = join(dir, "race-" + ms + ".db"); const seedDb = seed(f);
  const ra = seedDb.repo, rb = new Repo(openDatabase(f));
  const job = ra.createJob("scan", null, { path: "/race" });
  const la = ra.claimNextJob("A", { leaseMs: 1000, now: iso(base) });
  const leaseA = { holder: "A", token: Number(la.lease_token) };
  const [renew, reaped] = await Promise.all([
    Promise.resolve().then(() => { try { return ra.renewLease(job.id, leaseA, { now: iso(base + ms) }); } catch { return false; } }),
    Promise.resolve().then(() => { try { return rb.reapExpiredLeases({ now: iso(base + ms) }); } catch { return 0; } }),
  ]);
  const j = ra.getJob(job.id);
  const both = renew === true && reaped > 0;
  const consistent = both ? false : (renew === true ? (j.state === "resolving" && Number(j.lease_token) === Number(la.lease_token)) : (j.state === "queued" && Number(j.lease_token) === Number(la.lease_token) + 1));
  check("D-" + ms, "now=+" + ms + "ms：renew/reap 互斥且状态一致", consistent, "renew=" + renew + " reap=" + reaped + " state=" + j.state);
  ra.db.close(); rb.db.close();
}

// ============ E. 多任务并发 + 单条接管 ============
console.log("\n[E] 多任务并发领取与接管");
{
  const f = join(dir, "multi.db"); const s = seed(f);
  const ids = [s.repo.createJob("scan", null, { path: "/m1" }), s.repo.createJob("scan", null, { path: "/m2" }), s.repo.createJob("scan", null, { path: "/m3" })].map((j) => j.id);
  const ra = s.repo, rb = new Repo(openDatabase(f));
  const now = iso(base);
  const claims = await Promise.all([
    ...Array.from({ length: 6 }, (_, i) => Promise.resolve().then(() => (i % 2 ? rb : ra).claimNextJob("H" + i, { leaseMs: 5000, now }))),
  ]);
  const got = claims.filter(Boolean).map((c) => c.id);
  const uniq = new Set(got);
  check("E-1", "6 次并发领取：3 条作业各恰好被领一次", got.length === 3 && uniq.size === 3 && ids.every((id) => uniq.has(id)), "got=" + JSON.stringify(got));
  const one = claims.find((c) => c && c.id === ids[0]);
  const leaseOld = { holder: one.holder, token: Number(one.lease_token) };
  const reaped = rb.reapExpiredLeases({ now: iso(Date.parse(one.lease_until) + 1) });
  const queuedAfterReap = ra.getJob(one.id).state === "queued" && ra.getJob(one.id).holder === null;
  rb.claimNextJob("B", { leaseMs: 5000, now: iso(base + 60000) });
  let lost = null;
  try { ra.transitionJob(one.id, "resolve_ok", undefined, leaseOld); } catch (e) { lost = e; }
  check("E-2", "过期接管后旧持有者迟到 transition 被拒", reaped >= 1 && queuedAfterReap && lost instanceof LeaseLostError && ra.getJob(one.id).state === "resolving", "reaped=" + reaped);
  ra.db.close(); rb.db.close();
}

// ============ F. reap 重置子任务（v7 resetRunningTasksForJob） ============
console.log("\n[F] reap 重置子任务（FIX-02 新增）");
{
  const f = join(dir, "reset.db"); const s = seed(f);
  const ra = s.repo, rb = new Repo(openDatabase(f));
  const job = ra.createJob("scan", null, { path: "/reset" });
  ra.claimNextJob("A", { leaseMs: 1000, now: iso(base) });
  const t = ra.enqueueIndexTask({ assetId: s.asset, stage: "hash", jobId: job.id });
  const a = ra.claimIndexTask("hash", "A");
  const tokA = Number(a.lease_token);
  check("F-1", "作业 A 领取 + 其子任务 owner=A/running", a && a.job_id === job.id && a.owner === "A", JSON.stringify({ job_id: a && a.job_id, owner: a && a.owner }));
  const reaped = rb.reapExpiredLeases({ now: iso(base + 1001), reason: "lease expired" });
  const tr = rb.getIndexTask(t);
  check("F-2", "reap 作业后子任务回 queued、owner 清空、token+1",
    reaped === 1 && tr.state === "queued" && tr.owner === null && Number(tr.lease_token) === tokA + 1, JSON.stringify({ state: tr.state, owner: tr.owner, token: tr.lease_token }));
  const late = ra.finishIndexTask(t, "failed", { errorCode: "OLD", error: "old" }, { requireRunning: true, owner: "A", leaseToken: tokA });
  check("F-3", "旧 worker 迟到终态被拒（null）", late === null && rb.getIndexTask(t).state === "queued");
  const b = rb.claimIndexTask("hash", "B");
  const fin = rb.finishIndexTask(b.id, "done", {}, { requireRunning: true, owner: "B", leaseToken: Number(b.lease_token) });
  check("F-4", "B 重新领取并写终态成功", b && b.owner === "B" && fin && fin.state === "done", JSON.stringify({ owner: b && b.owner, fin: fin && fin.state }));
  ra.db.close(); rb.db.close();
}

console.log("\n" + (gaps === 0 ? "PASS" : "GAPS FOUND") + " " + pass + " passed / " + gaps + " gap(s)");
rmSync(dir, { recursive: true, force: true });
process.exit(0);
