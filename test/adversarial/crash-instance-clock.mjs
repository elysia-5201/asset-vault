/**
 * v0.6.1-G 对抗用例（verifier / task-15）：崩溃恢复 / 双实例 / 时钟边界 / 围栏 / 缓存 tmp。
 * 运行：node --import tsx test/adversarial/crash-instance-clock.mjs
 * 只用 os.tmpdir() 的一次性库；不触碰 data/vault.db。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { openDatabase } from "../../apps/server/src/db/migrate.ts";
import { Repo, LeaseLostError } from "../../apps/server/src/db/repo.ts";
import { DerivedCache } from "../../apps/server/src/services/pipeline/cache.ts";
import { acquirePipelineLock } from "../../apps/server/src/services/pipeline/lock.ts";
import { addItem, addAsset, addRoot } from "../schema/_db.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { if (ok) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); } };
const dir = mkdtempSync(join(tmpdir(), "av-adv-"));
const dbFile = join(dir, "vault.db");
const iso = (ms) => new Date(ms).toISOString();
const base = Date.parse("2026-10-20T10:00:00.000Z");

function seed(file) {
  const db = openDatabase(file);
  const repo = new Repo(db);
  let root;
  try { root = addRoot(db, "/adv"); }
  catch { root = Number(db.prepare("SELECT id FROM library_roots WHERE path_norm=?").get("/adv").id); }
  const item = addItem(db, { uid: "u-adv-" + Math.random().toString(36).slice(2) });
  const asset = addAsset(db, item, root, "/adv/a-" + Math.random().toString(36).slice(2) + ".zip");
  return { db, repo, root, item, asset };
}

// ---------- A. SIGKILL 崩溃 → 重启恢复 ----------
console.log("\n[A] SIGKILL 崩溃后恢复");
{
  const s = seed(dbFile);
  const job = s.repo.createJob("scan", null, { path: "/adv" });
  const task = s.repo.enqueueIndexTask({ assetId: s.asset, stage: "hash" });
  s.db.close();

  const child = spawn(process.execPath, ["--import", "tsx", join(HERE, "_crash-child.mjs"), dbFile], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += String(d); });
  const deadline = Date.now() + 15000;
  while (!out.includes("READY") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  check("子进程已领取 job/task", out.includes("READY"), out.slice(0, 120));
  const ready = JSON.parse(out.slice(out.indexOf("READY") + 5).trim());
  child.kill("SIGKILL");
  await new Promise((r) => child.on("exit", r));

  const s2 = seed(dbFile); // 重新打开同一库（seed 只用于取 repo/db）
  const integrity = s2.db.pragma("integrity_check", { simple: true });
  check("崩溃后 DB integrity_check=ok", integrity === "ok", String(integrity));
  const j0 = s2.repo.getJob(ready.jobId);
  check("崩溃后 job 仍在 resolving（不会凭空丢行）", j0 && j0.state === "resolving", j0?.state);
  const t0 = s2.repo.getIndexTask(ready.taskId);
  check("崩溃后 index task 仍在 running", t0 && t0.state === "running", t0?.state);

  const until = Date.parse(String(j0.lease_until));
  const reaped = s2.repo.reapExpiredLeases({ now: iso(until + 1), reason: "lease expired" });
  const j1 = s2.repo.getJob(ready.jobId);
  check("租约过期 → reap 回收 1 条", reaped === 1, String(reaped));
  check("job 回到 queued 且 holder 清空、token+1", j1.state === "queued" && j1.holder === null && Number(j1.lease_token) === Number(j0.lease_token) + 1, JSON.stringify(j1));
  const ev = s2.repo.listJobEvents(ready.jobId).at(-1);
  check("留 recovered 事件（detail 区分 lease expired）", ev && ev.event === "recovered" && String(ev.detail).startsWith("lease expired"), JSON.stringify(ev));
  const rec = s2.repo.recoverIndexTasks();
  check("recoverIndexTasks 把 running 任务排回 queued", rec === 1 && s2.repo.getIndexTask(ready.taskId).state === "queued", String(rec));
  s2.db.close();
}

// ---------- B. 双连接（模拟双实例）：CAS 领取 + fencing ----------
console.log("\n[B] 双连接领取与 fencing");
{
  const f2 = join(dir, "two.db");
  seed(f2);
  const a = openDatabase(f2), b = openDatabase(f2);
  const ra = new Repo(a), rb = new Repo(b);
  const job = ra.createJob("scan", null, { path: "/two" });
  const T = iso(base);
  const la = ra.claimNextJob("A", { leaseMs: 1000, now: T });
  check("A 领取成功、token=1", la && la.id === job.id && Number(la.lease_token) === 1, JSON.stringify(la));
  const lb = rb.claimNextJob("B", { leaseMs: 1000, now: T });
  check("B 立即领取同一条 → null（CAS）", lb === null);
  check("lease_until = T+1000", Date.parse(String(ra.getJob(job.id).lease_until)) === base + 1000);
  check("T+999 未过期 → reap=0", rb.reapExpiredLeases({ now: iso(base + 999) }) === 0);
  check("T+1000 恰好等于 lease_until → 仍不回收（严格小于）", rb.reapExpiredLeases({ now: iso(base + 1000) }) === 0);
  const reaped = rb.reapExpiredLeases({ now: iso(base + 1001) });
  check("T+1001 过期 → reap=1", reaped === 1, String(reaped));
  const lc = rb.claimNextJob("B", { leaseMs: 1000, now: iso(base + 2000) });
  check("B 接管后 token 继续递增", lc && Number(lc.lease_token) === Number(la.lease_token) + 2, JSON.stringify(lc));
  // 关键围栏：B 已接管并处于 resolving，A 的 resolve_ok 在状态机上合法，但租约 token 不匹配 → 必须被拒
  let lost = null;
  try { ra.transitionJob(job.id, "resolve_ok", undefined, { holder: "A", token: Number(la.lease_token) }); }
  catch (e) { lost = e; }
  check("旧持有者迟到写入 → LeaseLostError(LEASE_LOST/409)", lost instanceof LeaseLostError && lost.code === "LEASE_LOST" && lost.status === 409, String(lost));
  const after = ra.getJob(job.id);
  check("迟到写入未改状态（仍为 B 的 resolving）、未写 resolve_ok 事件", after.state === "resolving" && !ra.listJobEvents(job.id).some((e) => e.event === "resolve_ok"), after.state);
  a.close(); b.close();
}

// ---------- C. protectHolder / 自己的租约不被自回收 ----------
console.log("\n[C] protectHolder");
{
  const f3 = join(dir, "protect.db");
  seed(f3);
  const db = openDatabase(f3); const repo = new Repo(db);
  const job = repo.createJob("scan", null, { path: "/p" });
  const T = iso(base);
  repo.claimNextJob("self", { leaseMs: 10, now: T });
  check("protectHolder=self：过期也不回收", repo.reapExpiredLeases({ now: iso(base + 5000), protectHolder: "self" }) === 0);
  check("不保护时：同一条被回收", repo.reapExpiredLeases({ now: iso(base + 5000) }) === 1);
  check("reap 后 holder 为空", repo.getJob(job.id).holder === null);
  db.close();
}

// ---------- D. 缓存 tmp 清理 ----------
console.log("\n[D] 缓存 tmp 清理");
{
  const cacheRoot = join(dir, "cache");
  mkdirSync(join(cacheRoot, "k"), { recursive: true });
  writeFileSync(join(cacheRoot, "k", "dead.tmp-123"), "x");
  writeFileSync(join(cacheRoot, "k", "keep.json"), "{}");
  const s = seed(join(dir, "cache.db"));
  const cache = new DerivedCache(cacheRoot, s.repo);
  const removed = cache.pruneTemp();
  check("pruneTemp 删掉 .tmp-* 且保留正常文件", removed === 1 && !existsSync(join(cacheRoot, "k", "dead.tmp-123")) && existsSync(join(cacheRoot, "k", "keep.json")), String(removed));
  s.db.close();
}

// ---------- E. 第二实例锁（真实子进程） ----------
console.log("\n[E] 双实例文件锁");
{
  const lockDir = join(dir, "lock");
  mkdirSync(lockDir, { recursive: true });
  const runChild = () => new Promise((resolve) => {
    const c = spawn(process.execPath, ["--import", "tsx", join(HERE, "_lock-child.mjs"), lockDir], { stdio: ["ignore", "pipe", "pipe"] });
    let o = ""; c.stdout.on("data", (d) => { o += String(d); });
    c.on("exit", () => resolve(o.trim()));
  });
  const held = acquirePipelineLock(lockDir);
  check("父进程持有锁", held.acquired === true);
  const second = await runChild();
  check("第二进程获取锁 → ACQUIRED false", second.includes("ACQUIRED false"), second);
  held.release();
  const third = await runChild();
  check("父进程释放后，第二进程可获取 → ACQUIRED true", third.includes("ACQUIRED true"), third);
}

console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " " + pass + " passed / " + fail + " failed");
rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
