/**
 * /api/assets/:id/tree 目录完整性契约（新仪器，RED→GREEN）
 *
 * 需求：core→pipeline 落库的摘要必须出现在 tree API；旧条目无记录 → completeness=unknown，
 * 不能以「没报 truncated」冒充完整；目录完整但内容读取受限要能区分。
 * 实现：临时合成 DB + Fastify inject（不连生产库/不读真实归档）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { openTempDb, addItem, addRoot, addAsset } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerRoutes } from "../../apps/server/src/http/routes";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";

function makeApp(repo: Repo) {
  const app = Fastify({ logger: false });
  registerRoutes(app as any, {
    repo, media: {} as any, booth: {} as any, runner: {} as any, watcher: undefined,
    log: () => {}, version: "0.0.0-test", dbPath: "/tmp/test.db", dataDir: "/tmp",
    pipeline: null, limits: resolveLimits({}),
  } as any);
  return app;
}

function seed() {
  const t = openTempDb();
  const repo = new Repo(t.db);
  const rootId = addRoot(t.db, "/lib");
  const itemId = addItem(t.db, { title: "tree" });
  const assetId = addAsset(t.db, itemId, rootId, "/lib/a.zip");
  repo.replaceArchiveEntries(assetId, [
    { path: "a.txt", size: 10, isDir: false },
    { path: "b.psd", size: 20, isDir: false },
  ]);
  return { t, repo, assetId };
}

test("新条目：摘要透传（截断原因/flag/contentReadLimited）", async () => {
  const { t, repo, assetId } = seed();
  try {
    repo.setAssetArchiveListing(assetId, JSON.stringify({
      mode: "metadata", complete: false,
      stoppedReason: { code: "BYTES", message: "central directory 999 > maxMetadataBytes 64" },
      flags: [{ code: "BYTES", message: "entry b.psd declared 20 > maxEntryBytes 8" }],
      listedEntries: 2, declaredBytesListed: 30, contentReadLimited: true,
    }));
    const app = makeApp(repo);
    const res = await app.inject({ method: "GET", url: "/api/assets/" + assetId + "/tree" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.completeness, "truncated");
    assert.equal(body.truncated, true);
    assert.match(String(body.stoppedReason?.message), /maxMetadataBytes/);
    assert.equal(body.flags.length, 1);
    assert.equal(body.contentReadLimited, true);
    assert.equal(body.listing?.mode, "metadata");
    await app.close();
  } finally { t.close(); }
});

test("完整目录但内容读取受限：complete=true 仍标 contentReadLimited", async () => {
  const { t, repo, assetId } = seed();
  try {
    repo.setAssetArchiveListing(assetId, JSON.stringify({
      mode: "metadata", complete: true, stoppedReason: null,
      flags: [{ code: "BYTES", message: "entry b.psd declared 20 > maxEntryBytes 8" }],
      listedEntries: 2, contentReadLimited: true,
    }));
    const app = makeApp(repo);
    const body = JSON.parse((await app.inject({ method: "GET", url: "/api/assets/" + assetId + "/tree" })).body);
    assert.equal(body.completeness, "complete");
    assert.equal(body.truncated, false);
    assert.equal(body.contentReadLimited, true, "目录完整 ≠ 文件都能解压");
    await app.close();
  } finally { t.close(); }
});

test("旧条目无摘要：completeness=unknown（不冒充完整）", async () => {
  const { t, repo, assetId } = seed();
  try {
    const app = makeApp(repo);
    const body = JSON.parse((await app.inject({ method: "GET", url: "/api/assets/" + assetId + "/tree" })).body);
    assert.equal(body.completeness, "unknown");
    assert.equal(body.truncated, null);
    assert.equal(body.listing, null);
    await app.close();
  } finally { t.close(); }
});
