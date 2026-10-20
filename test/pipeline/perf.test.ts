/**
 * v0.6.1 task-17 P1 性能改动的"安全网"测试（不改语义，只钉住新结构的行为）
 * 覆盖：有界语句缓存（≤256 且不随调用次数增长）、固定分块计数、claim RETURNING vs fallback 等价、
 *       整链单事务（assetState 失败 → 全部回滚）、refresh 每链一次（≤2 次 setAssetIndexState）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openTempDb, addItem, addRoot, addAsset, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { IndexPipeline } from "../../apps/server/src/services/pipeline/pipeline";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

describe("有界语句缓存（task-17 #2）", () => {
  test("不同长度 IN 列表反复调用：缓存 ≤256 且不随调用次数增长", () => {
    const t = openTempDb();
    try {
      const repo = new Repo(t.db);
      for (let round = 0; round < 40; round++) {
        for (let n = 1; n <= 50; n++) {
          const ids = Array.from({ length: n }, (_, i) => 100000 + i);
          assert.equal(repo.countActiveIndexTasks(ids), 0, "无任务时应为 0");
        }
      }
      const a = repo.stmtCacheSize();
      assert.ok(a <= 256, "缓存必须封顶 256，实际 " + a);
      for (let round = 0; round < 40; round++) for (let n = 1; n <= 50; n++) repo.countActiveIndexTasks(Array.from({ length: n }, (_, i) => i + 1));
      const b = repo.stmtCacheSize();
      assert.equal(b, a, "缓存条目数不得随调用次数继续增长（前 " + a + " 后 " + b + "）");
      assert.ok(b <= 256);
    } finally { t.close(); }
  });

  test("固定分块计数正确：padding 0 不匹配任何 asset_id", () => {
    const t = openTempDb();
    try {
      const repo = new Repo(t.db);
      const itemId = addItem(t.db); const rootId = addRoot(t.db, "/lib");
      const a1 = addAsset(t.db, itemId, rootId, "/lib/a.zip");
      const a2 = addAsset(t.db, itemId, rootId, "/lib/b.zip");
      repo.enqueueIndexTask({ assetId: a1, stage: "hash", priority: 50 });
      repo.enqueueIndexTask({ assetId: a2, stage: "hash", priority: 50 });
      assert.equal(repo.countActiveIndexTasks([a1]), 1);
      assert.equal(repo.countActiveIndexTasks([a1, a2]), 2);
      assert.equal(repo.countActiveIndexTasks([a1, a2, 999999]), 2);
      // 401 个 id 跨块：只应统计真实存在的 2 个
      const many = [a1, a2, ...Array.from({ length: 399 }, (_, i) => 500000 + i)];
      assert.equal(repo.countActiveIndexTasks(many), 2);
    } finally { t.close(); }
  });
});

describe("claim：RETURNING 与 fallback 行为等价（task-17 #5）", () => {
  let seq = 0;
  const mk = (db: any, repo: Repo) => {
    seq++;
    const base = "/lib" + seq;
    const itemId = addItem(db); const rootId = addRoot(db, base);
    const assetId = addAsset(db, itemId, rootId, base + "/c.zip");
    repo.enqueueIndexTask({ assetId, stage: "hash", priority: 10 });
  };
  const shape = (task: any) => ({
    state: task.state, stage: task.stage, attempts: task.attempts,
    started: typeof task.started_at === "string" && task.started_at.length > 0,
    nextRetry: task.next_retry_at,
  });
  test("两条连接（开启/禁用 RETURNING）领取同一条：字段语义一致，且只有一方拿到", () => {
    const t = openTempDb();
    try {
      const db2 = new Database(t.file);
      db2.pragma("journal_mode = WAL"); db2.pragma("foreign_keys = ON"); db2.pragma("busy_timeout = 5000");
      const probe = new Repo(t.db);
      mk(t.db, probe);
      const returning = new Repo(t.db);
      const fallback = new Repo(db2, { disableReturning: true });
      const r1 = returning.claimIndexTask("hash");
      const r2 = fallback.claimIndexTask("hash");
      assert.ok(r1, "RETURNING 路径应领到");
      assert.equal(r2, null, "已被领走，另一连接必须拿不到");
      assert.deepEqual(shape(r1), { state: "running", stage: "hash", attempts: 1, started: true, nextRetry: null });
      // 另一条任务：fallback 路径同样成功
      mk(t.db, probe);
      const f = fallback.claimIndexTask("hash");
      assert.ok(f, "fallback 路径也必须能领到");
      assert.deepEqual(shape(f), { state: "running", stage: "hash", attempts: 1, started: true, nextRetry: null });
      db2.close();
    } finally { t.close(); }
  });
});

describe("整链入队：单事务 + 幂等（task-17 #4）", () => {
  const chain = [
    { stage: "hash", dependsOnStage: null },
    { stage: "meta", dependsOnStage: "hash" },
    { stage: "categorize", dependsOnStage: "meta" },
    { stage: "fts", dependsOnStage: "categorize" },
  ];
  test("一次事务生成 4 条并解析 depends_on；重放 id 完全复用；assetState 同事务", () => {
    const t = openTempDb();
    try {
      const repo = new Repo(t.db);
      const itemId = addItem(t.db); const rootId = addRoot(t.db, "/lib");
      const assetId = addAsset(t.db, itemId, rootId, "/lib/d.zip");
      const ids = repo.enqueueIndexTaskChain({ assetId, priority: 50, maxAttempts: 3, fingerprint: "1:2", versionKey: "v1", stages: chain, assetState: { state: "queued" } });
      assert.equal(ids.length, 4);
      assert.equal((t.db.prepare("SELECT COUNT(*) c FROM index_tasks").get() as any).c, 4);
      const rows = t.db.prepare("SELECT id, stage, depends_on FROM index_tasks ORDER BY id").all() as any[];
      assert.deepEqual(rows.map((r) => r.stage), ["hash", "meta", "categorize", "fts"]);
      assert.equal(rows[1].depends_on, rows[0].id);
      assert.equal(rows[2].depends_on, rows[1].id);
      assert.equal(rows[3].depends_on, rows[2].id);
      assert.equal((repo.getAsset(assetId) as any).index_state, "queued");
      // 重放（幂等）：id 完全复用，不新增行
      const again = repo.enqueueIndexTaskChain({ assetId, priority: 50, maxAttempts: 3, fingerprint: "1:2", versionKey: "v1", stages: chain, assetState: { state: "queued" } });
      assert.deepEqual(again, ids);
      assert.equal((t.db.prepare("SELECT COUNT(*) c FROM index_tasks").get() as any).c, 4);
      // 单事务回滚：assetState 写入抛错 → 4 条任务全部回滚
      const assetId2 = addAsset(t.db, itemId, rootId, "/lib/e.zip");
      const orig = repo.setAssetIndexState.bind(repo);
      (repo as any).setAssetIndexState = () => { throw new Error("state boom"); };
      try {
        assert.throws(() => repo.enqueueIndexTaskChain({ assetId: assetId2, priority: 50, maxAttempts: 3, fingerprint: null, versionKey: "v1", stages: chain, assetState: { state: "queued" } }), /state boom/);
      } finally { (repo as any).setAssetIndexState = orig; }
      assert.equal(repo.listIndexTasks({ assetId: assetId2 }).length, 0, "整链必须随失败事务回滚");
    } finally { t.close(); }
  });
});

describe("refresh 每链一次（task-17 #3）", () => {
  test("单资产链跑完：setAssetIndexState 调用 ≤2 且最终 index_state=done", async () => {
    const t = openTempDb();
    const dir = tmp("av-perf-asset-");
    const mediaDir = tmp("av-perf-media-");
    const cacheDir = tmp("av-perf-cache-");
    try {
      const repo = new Repo(t.db);
      const itemId = addItem(t.db); const rootId = addRoot(t.db, "/lib");
      const file = join(dir, "note.txt");
      writeFileSync(file, "hello asset vault");
      const assetId = addAsset(t.db, itemId, rootId, "/lib/note.txt", {
        kind: "loose_file", container: "file", path: file, size: 17, mtime: "2026-10-20T00:00:00.000Z",
      });
      let setStateCalls = 0;
      const orig = repo.setAssetIndexState.bind(repo);
      (repo as any).setAssetIndexState = (...a: any[]) => { setStateCalls++; return (orig as any)(...a); };
      const logs: string[] = [];
      const pipeline = new IndexPipeline({
        repo,
        media: { saveImage: async () => ({ filePath: "", thumbPath: null }) } as any,
        cache: { pruneTemp: () => 0, get: async () => null, put: async () => ({ bytes: 0 }) } as any,
        limits: resolveLimits({ progressFlushMs: 999999 }),
        log: (m) => logs.push(m),
      });
      pipeline.start();
      try {
        pipeline.enqueueAsset(assetId, { priority: 50 });
        const settled = await pipeline.drain(30000);
        assert.equal(settled, true, "单资产链必须收敛；logs=" + logs.slice(-3).join(" | "));
      } finally {
        await pipeline.stop();
      }
      assert.ok(setStateCalls <= 2, "每链最多 queued + 终态两次，实际 " + setStateCalls);
      assert.equal((repo.getAsset(assetId) as any).index_state, "done", "链尾必须刷新为 done");
    } finally { t.close(); rmSync(dir, { recursive: true, force: true }); rmSync(mediaDir, { recursive: true, force: true }); rmSync(cacheDir, { recursive: true, force: true }); }
  });
});
