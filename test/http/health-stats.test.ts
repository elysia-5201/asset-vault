/**
 * FIX-03：/api/health.counts 与 /api/stats 同源 deepEqual（口径文档见 docs/stats-counts.md）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { openTempDb, addItem, addRoot, addAsset } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerRoutes } from "../../apps/server/src/http/routes";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";

test("health.counts 与 /api/stats 返回同一口径（deepEqual）", async () => {
  const t = openTempDb();
  try {
    const repo = new Repo(t.db);
    const rootId = addRoot(t.db, "/lib");
    const itemId = addItem(t.db, { title: "stats" });
    addAsset(t.db, itemId, rootId, "/lib/a.zip");
    const missing = addAsset(t.db, itemId, rootId, "/lib/gone.zip");
    repo.markAssetsMissing([missing]);
    const trashedItem = addItem(t.db, { title: "回收站" });
    t.db.prepare("UPDATE items SET status='trashed' WHERE id=?").run(trashedItem);
    const trashedAsset = addAsset(t.db, itemId, rootId, "/lib/trashed.zip");
    t.db.prepare("UPDATE assets SET status='trashed' WHERE id=?").run(trashedAsset);

    const app = Fastify({ logger: false });
    registerRoutes(app as any, {
      repo, media: {} as any, booth: {} as any, runner: {} as any, watcher: undefined,
      log: () => {}, version: "0.0.0-test", dbPath: "/tmp/test.db", dataDir: "/tmp",
      pipeline: null, limits: resolveLimits({}),
    } as any);
    const health = await app.inject({ method: "GET", url: "/api/health" });
    const stats = await app.inject({ method: "GET", url: "/api/stats" });
    assert.equal(health.statusCode, 200);
    assert.equal(stats.statusCode, 200);
    const h = JSON.parse(health.body);
    const s = JSON.parse(stats.body);
    assert.deepEqual(h.counts, s, "两端点必须同源同值");
    assert.equal(s.items, 1, "items 不含回收站条目");
    assert.equal(s.assets, 2, "assets 含 missing、不含 trashed（当前口径）");
    assert.equal(s.missing, 1);
    assert.equal(h.version, "0.0.0-test", "health.version 必须来自调用方（CLI 传 package.json）");
  } finally { t.close(); }
});
