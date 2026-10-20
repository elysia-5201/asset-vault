/**
 * v0.6.1-C jobs 租约与心跳 —— 测试（task-11）
 *
 * 本文件先落地与 lease 同一批 v6 迁移的两项跨任务前置（lead 批准）：
 *   ① v6 迁移：jobs 租约列 + cache_entries.weak（幂等；v5 老库先补列再执行 schema.sql）
 *   ② repo.upsertAsset：同路径 size/mtime 变化 ⇒ sha256 作废（NULL/'pending'），未变化不重置
 * 租约/心跳/接管/fencing 的竞态测试会在实现获批后追加到本文件（同一写范围）。
 *
 * 实现：apps/server/src/db/{schema.sql,migrate.ts,repo.ts}（测试不改实现）
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_PATH, openTempDb, addItem, addRoot, addJob, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { JobRunner } from "../../apps/server/src/jobs/runner";
import { applyColumnMigrations, SCHEMA_VERSION } from "../../apps/server/src/db/migrate";

const MT1 = "2026-10-01T00:00:00.000Z";
const MT2 = "2026-10-02T00:00:00.000Z";

/** 只建 v5 形态的 jobs / cache_entries，用来验证"老库补列"路径。 */
function openV5Db(): { db: Database.Database; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "av-v6-migrate-"));
  const db = new Database(join(dir, "v5.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, item_id INTEGER, payload TEXT,
      state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL,
      started_at TEXT, finished_at TEXT
    );
    CREATE TABLE cache_entries (
      key TEXT PRIMARY KEY, kind TEXT NOT NULL, content_sha TEXT, version_key TEXT NOT NULL,
      file_path TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'ready', created_at TEXT NOT NULL, last_used_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO jobs(kind,state,created_at) VALUES ('scan','queued',?)").run(MT1);
  db.prepare("INSERT INTO cache_entries(key,kind,version_key,file_path,created_at,last_used_at) VALUES ('k1','archive-listing','v1','/tmp/x',?,?)").run(MT1, MT1);
  return { db, close: () => { try { db.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); } };
}

describe("v6/v7 迁移：jobs 租约列 + cache_entries.weak + index_tasks 围栏列", () => {
  test("SCHEMA_VERSION = 7", () => {
    assert.equal(SCHEMA_VERSION, 7);
  });

  test("v5 老库：补 5 列（4 租约 + weak），幂等；schema.sql 随后可执行（新索引可建）", () => {
    const { db, close } = openV5Db();
    try {
      const added = applyColumnMigrations(db);
      assert.deepEqual(added.sort(), [
        "cache_entries.weak", "jobs.heartbeat_at", "jobs.holder", "jobs.lease_token", "jobs.lease_until",
      ].sort());
      // 幂等：第二次不再补列
      assert.deepEqual(applyColumnMigrations(db), []);

      // 老行拿到默认值：lease_token=0（无租约）、weak=0（强身份；语义不变）
      const job = db.prepare("SELECT * FROM jobs WHERE id=1").get() as any;
      assert.equal(job.lease_token, 0);
      assert.equal(job.holder, null);
      assert.equal(job.lease_until, null);
      assert.equal(job.heartbeat_at, null);
      const cache = db.prepare("SELECT * FROM cache_entries WHERE key='k1'").get() as any;
      assert.equal(cache.weak, 0);

      // 关键顺序：必须先补列，schema.sql 里针对新列的索引才可执行
      db.exec(readFileSync(SCHEMA_PATH, "utf8"));
      const idx = (db.prepare("PRAGMA index_list(jobs)").all() as { name: string }[]).map((r) => r.name);
      assert.ok(idx.includes("ix_jobs_lease"), "schema.sql 必须建出 ix_jobs_lease，实际：" + idx.join(","));
      const jobCols = (db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((r) => r.name);
      for (const c of ["holder", "lease_until", "lease_token", "heartbeat_at"]) assert.ok(jobCols.includes(c), "缺列 " + c);
      const cacheCols = (db.prepare("PRAGMA table_info(cache_entries)").all() as { name: string }[]).map((r) => r.name);
      assert.ok(cacheCols.includes("weak"));
    } finally { close(); }
  });

  test("新库 schema.sql 自带租约列/索引与 weak；重复执行仍幂等", () => {
    const t = openTempDb();
    try {
      const cols = (t.db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((r) => r.name);
      for (const c of ["holder", "lease_until", "lease_token", "heartbeat_at"]) assert.ok(cols.includes(c), "缺列 " + c);
      const idx = (t.db.prepare("PRAGMA index_list(jobs)").all() as { name: string }[]).map((r) => r.name);
      assert.ok(idx.includes("ix_jobs_lease"));
      const cacheCols = (t.db.prepare("PRAGMA table_info(cache_entries)").all() as { name: string }[]).map((r) => r.name);
      assert.ok(cacheCols.includes("weak"));
      t.db.exec(readFileSync(SCHEMA_PATH, "utf8")); // 幂等
    } finally { t.close(); }
  });
});

describe("upsertAsset：size/mtime 变化 → sha256 作废（F3）", () => {
  let t: TempDb; let repo: Repo; let itemId: number; let rootId: number;
  const mk = (size: number, mtime: string) => ({
    item_id: itemId, kind: "archive" as const, container: "zip" as const,
    path: "/lib/a.zip", path_norm: "/lib/a.zip", root_id: rootId, size, mtime,
    discovered_by: "scan" as const,
  });
  const seed = () => {
    t = openTempDb(); repo = new Repo(t.db);
    itemId = addItem(t.db); rootId = addRoot(t.db, "/lib");
    const r = repo.upsertAsset(mk(100, MT1));
    assert.equal(r.created, true);
    assert.equal(r.asset.sha256_state, "pending", "新资产默认 pending");
    return r.asset.id;
  };

  test("未变化：不重置 sha256/sha256_state（负例对照：防止每轮扫描把哈希打回 pending）", () => {
    const id = seed();
    repo.setAssetSha(id, "a".repeat(64), "ok");
    const r = repo.upsertAsset(mk(100, MT1));
    assert.equal(r.created, false);
    const row = repo.getAsset(id)!;
    assert.equal(row.sha256, "a".repeat(64));
    assert.equal(row.sha256_state, "ok");
  });

  test("size 变化：sha256=NULL、sha256_state='pending'（陈旧哈希不得再当强身份）", () => {
    const id = seed();
    repo.setAssetSha(id, "b".repeat(64), "ok");
    repo.upsertAsset(mk(200, MT1));
    const row = repo.getAsset(id)!;
    assert.equal(row.sha256, null);
    assert.equal(row.sha256_state, "pending");
  });

  test("mtime 变化（size 不变）：同样作废", () => {
    const id = seed();
    repo.setAssetSha(id, "c".repeat(64), "ok");
    repo.upsertAsset(mk(100, MT2));
    const row = repo.getAsset(id)!;
    assert.equal(row.sha256, null);
    assert.equal(row.sha256_state, "pending");
  });

  test("重新哈希后可再次 ok；setAssetSha 接受 'pending'", () => {
    const id = seed();
    repo.setAssetSha(id, "d".repeat(64), "ok");
    repo.upsertAsset(mk(300, MT2));
    assert.equal(repo.getAsset(id)!.sha256_state, "pending");
    repo.setAssetSha(id, "e".repeat(64), "ok");
    assert.equal(repo.getAsset(id)!.sha256, "e".repeat(64));
    repo.setAssetSha(id, null, "pending");
    assert.equal(repo.getAsset(id)!.sha256_state, "pending");
    assert.equal(repo.getAsset(id)!.sha256, null);
  });
});

describe("upsertCacheEntry.weak（v6）", () => {
  test("weak=true/false/省略 → 落库 1/0/0；同 key 更新会覆盖 weak", () => {
    const t = openTempDb();
    try {
      const repo = new Repo(t.db);
      const base = { key: "k1", kind: "archive-listing", contentSha: null, versionKey: "v1", filePath: "/tmp/k1.json", bytes: 10 };
      repo.upsertCacheEntry({ ...base, weak: true });
      assert.equal(repo.getCacheEntry("k1").weak, 1);
      repo.upsertCacheEntry({ ...base, weak: false });
      assert.equal(repo.getCacheEntry("k1").weak, 0);
      repo.upsertCacheEntry({ ...base, key: "k2" });
      assert.equal(repo.getCacheEntry("k2").weak, 0);
    } finally { t.close(); }
  });

  test("降级：v5 表没有 weak 列 → 不抛错、忽略 weak（缓存仍可用，可重复 upsert）", () => {
    const dir = mkdtempSync(join(tmpdir(), "av-v6-cache-"));
    const db = new Database(join(dir, "c.db"));
    try {
      db.exec(`CREATE TABLE cache_entries (
        key TEXT PRIMARY KEY, kind TEXT NOT NULL, content_sha TEXT, version_key TEXT NOT NULL,
        file_path TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'ready', created_at TEXT NOT NULL, last_used_at TEXT NOT NULL)`);
      const repo = new Repo(db);
      const e = { key: "k1", kind: "meta", contentSha: null, versionKey: "v1", filePath: "/tmp/k1.json", bytes: 5 };
      repo.upsertCacheEntry({ ...e, weak: true }); // 降级：不写 weak
      repo.upsertCacheEntry({ ...e, weak: true });
      const row = repo.getCacheEntry("k1");
      assert.ok(row);
      assert.equal(row.bytes, 5);
      assert.equal(row.weak, undefined, "v5 表不应该凭空多出 weak");
    } finally { try { db.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); }
  });
});

// =====================================================================================
// v6 租约 / 心跳 / 接管 / fencing 竞态测试
//  - 多连接同一临时库（真实 WAL），显式传 now/leaseMs，不用 sleep，不依赖真实时钟
//  - 旧的 runJob 直接调用（无 lease）保持兼容：见 test/repro/m0-runner-missing-gate.mjs
// =====================================================================================
const T1 = "2026-10-01T00:00:00.000Z";
const T2 = "2026-10-01T00:01:00.000Z";
const T3 = "2026-10-01T00:02:00.000Z";
const LEASE = 60_000;

function openPair() {
  const t = openTempDb();
  const db2 = new Database(t.file);
  db2.pragma("journal_mode = WAL");
  db2.pragma("foreign_keys = ON");
  db2.pragma("busy_timeout = 5000");
  return {
    t, repoA: new Repo(t.db), repoB: new Repo(db2),
    close: () => { try { db2.close(); } catch { /* closed */ } t.close(); },
  };
}
const ev = (repo: Repo, id: number) => repo.listJobEvents(id) as any[];

describe("lease：领取 CAS 与 fencing token", () => {
  test("同一 queued 行：两个 holder 只有一个领到；token=1、lease_until=now+60s、只有 1 条 start", () => {
    const p = openPair();
    try {
      const id = addJob(p.t.db, null, "scan", "queued");
      const a = p.repoA.claimNextJob("A", { now: T1, leaseMs: LEASE })!;
      assert.ok(a, "A 必须领到");
      assert.equal(a.id, id);
      assert.equal(a.state, "resolving");
      assert.equal(a.attempts, 1);
      assert.equal(a.holder, "A");
      assert.equal(a.lease_token, 1);
      assert.equal(a.heartbeat_at, T1);
      assert.equal(a.lease_until, new Date(Date.parse(T1) + LEASE).toISOString());
      assert.equal(p.repoB.claimNextJob("B", { now: T1, leaseMs: LEASE }), null);
      assert.deepEqual(ev(p.repoA, id).map((e) => e.event), ["start"]);
    } finally { p.close(); }
  });

  test("两条 queued：两个连接各领一条，不互相挡住（旧实现的空转 tick 不影响正确性）", () => {
    const p = openPair();
    try {
      const x = addJob(p.t.db, null, "scan", "queued");
      const y = addJob(p.t.db, null, "reindex", "queued");
      const a = p.repoA.claimNextJob("A", { now: T1 })!;
      const b = p.repoB.claimNextJob("B", { now: T1 })!;
      assert.deepEqual([a.id, b.id].sort((m, n) => m - n), [x, y].sort((m, n) => m - n));
      assert.notEqual(a.holder, b.holder);
      assert.equal(p.repoA.claimNextJob("A", { now: T1 }), null);
    } finally { p.close(); }
  });
});

describe("lease：心跳续租", () => {
  test("续租延长 lease_until/heartbeat_at；错 holder 或错 token 返回 false 且不延长（负例对照）", () => {
    const p = openPair();
    try {
      const id = addJob(p.t.db, null, "scan", "queued");
      const job = p.repoA.claimNextJob("A", { now: T1, leaseMs: LEASE })!;
      const lease = { holder: "A", token: job.lease_token };
      assert.equal(p.repoA.renewLease(id, lease, { now: T2, leaseMs: LEASE }), true);
      const after = p.repoA.getJob(id)! as any;
      assert.equal(after.lease_until, new Date(Date.parse(T2) + LEASE).toISOString());
      assert.equal(after.heartbeat_at, T2);
      const before = after.lease_until;
      assert.equal(p.repoA.renewLease(id, { holder: "B", token: lease.token }, { now: T3 }), false);
      assert.equal(p.repoA.renewLease(id, { holder: "A", token: lease.token + 99 }, { now: T3 }), false);
      assert.equal((p.repoA.getJob(id) as any).lease_until, before);
      assert.equal(p.repoA.holdsLease(id, lease), true);
      assert.equal(p.repoA.holdsLease(id, { holder: "A", token: lease.token + 1 }), false);
    } finally { p.close(); }
  });
});

describe("lease：过期接管（reapExpiredLeases）", () => {
  test("过期 → queued + holder 清空 + token+1 + 1 条 recovered；随后可被别的 runner 领取", () => {
    const p = openPair();
    try {
      const id = addJob(p.t.db, null, "scan", "queued");
      const a = p.repoA.claimNextJob("A", { now: T1, leaseMs: 1000 })!;
      const n = p.repoB.reapExpiredLeases({ now: T2 });
      assert.equal(n, 1);
      const row = p.repoB.getJob(id)! as any;
      assert.equal(row.state, "queued");
      assert.equal(row.holder, null);
      assert.equal(row.lease_until, null);
      assert.equal(row.lease_token, 2);
      assert.equal(row.started_at, null);
      const events = ev(p.repoB, id);
      assert.deepEqual(events.map((e) => e.event), ["start", "recovered"]);
      assert.match(String(events[1].detail), /lease expired .*holder=A/);
      const b = p.repoB.claimNextJob("B", { now: T3, leaseMs: LEASE })!;
      assert.equal(b.id, id);
      assert.equal(b.holder, "B");
      assert.equal(b.lease_token, 3);
      assert.equal(b.attempts, 2);
    } finally { p.close(); }
  });

  test("有效租约不被误伤：另一实例启动恢复/reap 都是 0，状态与事件不变（旧 bug 回归）", () => {
    const p = openPair();
    try {
      const id = addJob(p.t.db, null, "scan", "queued");
      const realNow = new Date().toISOString();
      p.repoA.claimNextJob("A", { now: realNow, leaseMs: LEASE });
      const before = ev(p.repoA, id).length;
      assert.equal(p.repoB.recoverInFlight(), 0, "活实例的作业不能被另一实例的启动恢复误伤");
      assert.equal(p.repoB.reapExpiredLeases(), 0);
      assert.equal((p.repoB.getJob(id) as any).state, "resolving");
      assert.equal(ev(p.repoB, id).length, before);
    } finally { p.close(); }
  });

  test("重复恢复幂等：同一行第二次 reap 返回 0、不追加事件", () => {
    const p = openPair();
    try {
      const id = addJob(p.t.db, null, "scan", "queued");
      p.repoA.claimNextJob("A", { now: T1, leaseMs: 1000 });
      assert.equal(p.repoB.reapExpiredLeases({ now: T2 }), 1);
      const n = ev(p.repoB, id).length;
      assert.equal(p.repoB.reapExpiredLeases({ now: T3 }), 0);
      assert.equal(ev(p.repoB, id).length, n);
      assert.equal((p.repoB.getJob(id) as any).state, "queued");
    } finally { p.close(); }
  });

  test("心跳抢跑：租约已续到未来时，用旧的 now 回收也不会把它打回 queued", () => {
    const p = openPair();
    try {
      const id = addJob(p.t.db, null, "scan", "queued");
      const a = p.repoA.claimNextJob("A", { now: T1, leaseMs: 1000 })!;
      // 模拟"回收器已 SELECT 到过期快照"之后发生了一次心跳
      p.t.db.prepare("UPDATE jobs SET lease_until=? WHERE id=?").run(T2, id);
      assert.equal(p.repoA.renewLease(id, { holder: "A", token: a.lease_token }, { now: T3, leaseMs: LEASE }), true);
      assert.equal(p.repoB.reapExpiredLeases({ now: T2 }), 0, "续租后的 lease_until 必须让过期判定失败");
      assert.equal((p.repoB.getJob(id) as any).state, "resolving");
    } finally { p.close(); }
  });

  test("paused / 终态不回收；过期租约的 paused 也保持暂停", () => {
    const p = openPair();
    try {
      const paused = addJob(p.t.db, null, "scan", "paused", { holder: "A", lease_until: T1, started_at: T1 });
      const done = addJob(p.t.db, null, "scan", "done", { holder: "A", lease_until: T1, finished_at: T1 });
      assert.equal(p.repoB.reapExpiredLeases({ now: T3 }), 0);
      assert.equal((p.repoB.getJob(paused) as any).state, "paused");
      assert.equal((p.repoB.getJob(done) as any).state, "done");
    } finally { p.close(); }
  });
});

describe("lease：自回收保护（长同步段阻塞时 maintenance 不得误伤自己）", () => {
  test("同 holder 的过期租约：protectHolder 自己 → 不回收，状态/事件不变", () => {
    const p = openPair();
    try {
      const id = addJob(p.t.db, null, "scan", "queued");
      p.repoA.claimNextJob("A", { now: T1, leaseMs: 1000 });
      const before = ev(p.repoA, id).length;
      assert.equal(p.repoA.reapExpiredLeases({ now: T3, protectHolder: "A" }), 0);
      assert.equal((p.repoA.getJob(id) as any).state, "resolving");
      assert.equal(ev(p.repoA, id).length, before);
    } finally { p.close(); }
  });

  test("不同 holder 的过期租约：protectHolder=A 时 B 的行照常回收（跨进程接管不受影响）", () => {
    const p = openPair();
    try {
      const id = addJob(p.t.db, null, "scan", "queued");
      p.repoB.claimNextJob("B", { now: T1, leaseMs: 1000 });
      assert.equal(p.repoA.reapExpiredLeases({ now: T3, protectHolder: "A" }), 1);
      assert.equal((p.repoA.getJob(id) as any).state, "queued");
    } finally { p.close(); }
  });

  test("模拟 lease 到期但自己的 heartbeat 还没跑：maintenance 不回收，随后 renew 成功", () => {
    const p = openPair();
    try {
      const id = addJob(p.t.db, null, "scan", "queued");
      const a = p.repoA.claimNextJob("A", { now: T1, leaseMs: 1000 })!;
      const lease = { holder: "A", token: a.lease_token };
      // 已过期（lease_until=T1+1s，now=T3），但本进程活着、只是事件循环没来得及跑心跳
      assert.equal(p.repoA.reapExpiredLeases({ now: T3, protectHolder: "A" }), 0);
      assert.equal((p.repoA.getJob(id) as any).state, "resolving");
      assert.equal(p.repoA.renewLease(id, lease, { now: T3, leaseMs: LEASE }), true, "心跳恢复后必须能续租");
      assert.equal((p.repoA.getJob(id) as any).lease_until, new Date(Date.parse(T3) + LEASE).toISOString());
      // 从别的进程视角（protectHolder 不是 A）仍然可以按过期接管
      p.t.db.prepare("UPDATE jobs SET lease_until=? WHERE id=?").run(T1, id);
      assert.equal(p.repoB.reapExpiredLeases({ now: T3, protectHolder: "B" }), 1);
    } finally { p.close(); }
  });
});

describe("lease：旧持有者的迟到写入被 CAS 拒绝", () => {
  test("接管后旧持有者的 transition → LEASE_LOST(409)，状态与事件都不变", () => {
    const p = openPair();
    try {
      const id = addJob(p.t.db, null, "scan", "queued");
      const a = p.repoA.claimNextJob("A", { now: T1, leaseMs: 1000 })!;
      const leaseA = { holder: "A", token: a.lease_token };
      assert.equal(p.repoB.reapExpiredLeases({ now: T2 }), 1);
      const b = p.repoB.claimNextJob("B", { now: T3 })!;
      assert.equal(b.lease_token, leaseA.token + 2);
      const before = ev(p.repoB, id).map((e) => e.event);
      // 注意：当前状态是 resolving，旧代码（只按 state CAS）会接受这次 resolve_ok —— 复现过的洞
      assert.throws(
        () => p.repoA.transitionJob(id, "resolve_ok", undefined, leaseA),
        (e: any) => e.code === "LEASE_LOST" && e.status === 409,
        "迟到写入必须被 fencing token 拒绝"
      );
      assert.equal((p.repoB.getJob(id) as any).state, "resolving");
      assert.deepEqual(ev(p.repoB, id).map((e) => e.event), before, "被拒的转移绝不能写事件");
      // 诊断事件同样被围栏
      assert.equal(p.repoA.logJobEvent(id, null, "resolving", "late_diag", "x", leaseA), false);
      assert.deepEqual(ev(p.repoB, id).map((e) => e.event), before);
      // 新持有者正常工作
      assert.equal(p.repoB.transitionJob(id, "resolve_ok", undefined, { holder: "B", token: b.lease_token }).state, "fetching");
    } finally { p.close(); }
  });

  test("完成与过期同时发生：先完成则不被回收；先被回收则旧持有者不能再写成功", () => {
    const p = openPair();
    try {
      const idA = addJob(p.t.db, null, "scan", "queued");
      const a = p.repoA.claimNextJob("A", { now: T1, leaseMs: 1000 })!;
      const leaseA = { holder: "A", token: a.lease_token };
      for (const e of ["resolve_ok", "fetch_ok", "commit", "index_ok", "match_ok", "succeed"] as const) {
        p.repoA.transitionJob(idA, e, undefined, leaseA);
      }
      assert.equal((p.repoA.getJob(idA) as any).state, "done");
      assert.equal(p.repoB.reapExpiredLeases({ now: T3 }), 0, "done 不在可回收状态集合");
      assert.equal((p.repoB.getJob(idA) as any).state, "done");
      assert.equal(p.repoA.renewLease(idA, leaseA, { now: T3 }), false, "终态必须释放租约");

      const idB = addJob(p.t.db, null, "scan", "queued");
      const b = p.repoA.claimNextJob("A", { now: T1, leaseMs: 1000 })!;
      const leaseB = { holder: "A", token: b.lease_token };
      assert.equal(p.repoB.reapExpiredLeases({ now: T2 }), 1);
      // 已被回收（queued）时旧持有者的迟到写入：先被状态机拒绝
      assert.throws(() => p.repoA.transitionJob(idB, "succeed", undefined, leaseB),
        (e: any) => e.code === "LEASE_LOST" || e.code === "INVALID_TRANSITION");
      assert.equal((p.repoB.getJob(idB) as any).state, "queued", "不得把已回收的作业复活为 done");
      // B 重领后状态仍是 resolving（对旧持有者而言"状态没变"）：此时只能靠 fencing token 拒绝
      const b2 = p.repoB.claimNextJob("B", { now: T3 })!;
      assert.equal(b2.lease_token, leaseB.token + 2);
      assert.throws(() => p.repoA.transitionJob(idB, "resolve_ok", undefined, leaseB),
        (e: any) => e.code === "LEASE_LOST" && e.status === 409);
      assert.equal((p.repoB.getJob(idB) as any).state, "resolving");
    } finally { p.close(); }
  });
});

describe("lease：毒作业与恢复上限", () => {
  test("同一作业恢复 3 次 → failed + abandoned_after_recoveries；之后不再重复处理", () => {
    const p = openPair();
    try {
      const id = addJob(p.t.db, null, "scan", "resolving", { started_at: T1 });
      for (let i = 0; i < 3; i++) p.repoA.logJobEvent(id, "resolving", "queued", "recovered", "service restart");
      assert.equal(p.repoB.recoverInFlight(), 0, "被放弃的毒作业不计入恢复数");
      const row = p.repoB.getJob(id)! as any;
      assert.equal(row.state, "failed");
      assert.ok(row.finished_at);
      assert.match(String(row.error), /反复崩溃/);
      assert.equal(ev(p.repoB, id).at(-1).event, "abandoned_after_recoveries");
      assert.equal(p.repoB.recoverInFlight(), 0);
      assert.equal((p.repoB.getJob(id) as any).state, "failed");
    } finally { p.close(); }
  });

  test("旧库 NULL 租约（v5 遗留）仍走启动恢复，detail 保持 service restart（契约兼容）", () => {
    const p = openPair();
    try {
      const id = addJob(p.t.db, null, "scan", "indexing", { started_at: T1 });
      assert.equal(p.repoB.recoverInFlight(), 1);
      const events = ev(p.repoB, id);
      assert.equal(events.at(-1).event, "recovered");
      assert.equal(events.at(-1).detail, "service restart");
      assert.equal((p.repoB.getJob(id) as any).lease_token, 1);
    } finally { p.close(); }
  });
});

describe("lease：多 runner 并发领取（不重复执行）", () => {
  test("3 个 holder 争抢 5 条 queued：每条恰好被领一次，5 条 start 事件", () => {
    const p = openPair();
    try {
      const ids = Array.from({ length: 5 }, () => addJob(p.t.db, null, "scan", "queued"));
      const repos = [p.repoA, p.repoB, new Repo(p.t.db)];
      const holders = ["A", "B", "C"];
      const claimed: number[] = [];
      for (let round = 0; round < 10; round++) {
        for (let k = 0; k < 3; k++) {
          const j = repos[k].claimNextJob(holders[k], { now: T1 });
          if (j) claimed.push(j.id);
        }
      }
      assert.deepEqual([...claimed].sort((m, n) => m - n), [...ids].sort((m, n) => m - n));
      assert.equal(new Set(claimed).size, 5, "同一条作业不能被重复领取");
      const starts = p.t.db.prepare("SELECT COUNT(*) c FROM job_events WHERE event='start'").get() as any;
      assert.equal(Number(starts.c), 5);
    } finally { p.close(); }
  });
});

describe("lease：JobRunner 集成冒烟", () => {
  test("两个 runner 抢同一条快速失败作业：恰好一个 tick 处理；结束释放租约", async () => {
    const p = openPair();
    try {
      const id = addJob(p.t.db, null, "match_avatars", "queued"); // 无 item_id → 立即抛错
      const deps = { repo: p.repoA, media: {} as any, booth: {} as any, log: () => {} };
      const runnerA = new JobRunner(deps);
      const runnerB = new JobRunner({ ...deps, repo: p.repoB });
      const results = await Promise.all([runnerA.tick(), runnerB.tick()]);
      assert.equal(results.filter(Boolean).length, 1, "同一条作业只能被一个 runner 处理");
      const row = p.repoB.getJob(id)! as any;
      assert.equal(row.state, "failed");
      assert.equal(row.holder, null, "失败收尾必须释放租约");
      assert.equal(row.lease_until, null);
      assert.deepEqual(ev(p.repoB, id).map((e) => e.event), ["start", "stop", "fail"]);
    } finally { p.close(); }
  });
});
