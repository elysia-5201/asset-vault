/**
 * 目录 GET 只读化契约（task55）
 *
 * 目标：root tree GET 只读缓存；缓存缺失返回明确未就绪，不自动补索引/写库；
 *       合法空归档（listing 存在、0 条目）不得误判 missing。
 * 仪器：真实临时 SQLite + Fastify inject + 合成 ZIP；零写用 total_changes/行数/文件系统前后对照，
 *       并用一次真实写入作 positive control 证明仪器有判别力。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, writeFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTempDb, addItem, addRoot, addAsset } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerRoutes } from "../../apps/server/src/http/routes";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";
import { buildZip } from "../../packages/core/test/content/fixtures";

function makeApp(repo: Repo) {
  const app = Fastify({ logger: false });
  registerRoutes(app as any, {
    repo, media: {} as any, booth: {} as any, runner: {} as any, watcher: undefined,
    log: () => {}, version: "0.0.0-test", dbPath: "/tmp/test.db", dataDir: "/tmp",
    pipeline: null, limits: resolveLimits({}),
  } as any);
  return app;
}

function totalChanges(db: any): number { return Number(db.prepare("SELECT total_changes() c").get().c); }
function rowCounts(db: any) {
  return {
    entries: Number(db.prepare("SELECT COUNT(*) c FROM archive_entries").get().c),
    assets: Number(db.prepare("SELECT COUNT(*) c FROM assets").get().c),
  };
}
function stagingFiles(): string[] {
  return readdirSync(tmpdir()).filter((f) => f.startsWith("av-nested-tree-"));
}

function seed(opts: { entries?: { path: string; size: number; isDir: boolean }[]; listing?: any } = {}) {
  const t = openTempDb();
  const repo = new Repo(t.db);
  const dir = mkdtempSync(join(tmpdir(), "av-tree-ro-"));
  const zipPath = join(dir, "a.zip");
  writeFileSync(zipPath, buildZip([{ name: "Assets/x.prefab", data: Buffer.from("x") }]));
  const rootId = addRoot(t.db, "/lib");
  const itemId = addItem(t.db, { title: "t" });
  const assetId = addAsset(t.db, itemId, rootId, "/lib/a.zip", { path: zipPath, container: "zip", kind: "archive", size: statSync(zipPath).size });
  if (opts.entries) repo.replaceArchiveEntries(assetId, opts.entries);
  if (opts.listing !== undefined) repo.setAssetArchiveListing(assetId, JSON.stringify(opts.listing));
  return { t, repo, assetId, zipPath, dir };
}

test("ready：已有缓存直接读，零写", async () => {
  const s = seed({ entries: [{ path: "a.txt", size: 1, isDir: false }, { path: "b.psd", size: 2, isDir: false }],
    listing: { mode: "metadata", complete: true, listedEntries: 2, contentReadLimited: false } });
  try {
    const app = makeApp(s.repo);
    const before = { ch: totalChanges(s.t.db), rows: rowCounts(s.t.db), files: stagingFiles().length };
    const res = await app.inject({ method: "GET", url: "/api/assets/" + s.assetId + "/tree" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ready, true);
    assert.equal(body.entries.length, 2);
    assert.equal(body.completeness, "complete");
    assert.equal(totalChanges(s.t.db), before.ch, "GET 不得写库");
    assert.deepEqual(rowCounts(s.t.db), before.rows);
    assert.equal(stagingFiles().length, before.files, "不得新增 staging 文件");
    await app.close();
  } finally { s.t.close(); rmSync(s.dir, { recursive: true, force: true }); }
});

test("missing：缓存缺失明确未就绪，不自动补索引/写库", async () => {
  const s = seed();
  try {
    const app = makeApp(s.repo);
    const before = { ch: totalChanges(s.t.db), rows: rowCounts(s.t.db), files: stagingFiles().length, mtime: statSync(s.zipPath).mtimeMs };
    const res = await app.inject({ method: "GET", url: "/api/assets/" + s.assetId + "/tree" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ready, false, "缓存缺失必须明确未就绪");
    assert.equal(body.reason, "CACHE_MISSING");
    assert.deepEqual(body.entries, []);
    assert.equal(totalChanges(s.t.db), before.ch, "GET 不得写库（旧 lazy 分支会写 archive_entries）");
    assert.deepEqual(rowCounts(s.t.db), before.rows);
    assert.equal(stagingFiles().length, before.files);
    assert.equal(statSync(s.zipPath).mtimeMs, before.mtime, "不得改归档文件");
    await app.close();
  } finally { s.t.close(); rmSync(s.dir, { recursive: true, force: true }); }
});

test("合法空归档：listing 存在且 0 条目 → ready，不误判 missing", async () => {
  const s = seed({ listing: { mode: "metadata", complete: true, listedEntries: 0, contentReadLimited: false } });
  try {
    const app = makeApp(s.repo);
    const res = await app.inject({ method: "GET", url: "/api/assets/" + s.assetId + "/tree" });
    const body = JSON.parse(res.body);
    assert.equal(body.ready, true);
    assert.deepEqual(body.entries, []);
    assert.equal(body.completeness, "complete");
    await app.close();
  } finally { s.t.close(); rmSync(s.dir, { recursive: true, force: true }); }
});

test("无效 ID → 404，零写", async () => {
  const s = seed();
  try {
    const app = makeApp(s.repo);
    const before = totalChanges(s.t.db);
    const res = await app.inject({ method: "GET", url: "/api/assets/999999/tree" });
    assert.equal(res.statusCode, 404);
    assert.equal(totalChanges(s.t.db), before);
    await app.close();
  } finally { s.t.close(); rmSync(s.dir, { recursive: true, force: true }); }
});

test("多次 GET 稳定且零写", async () => {
  const s = seed();
  try {
    const app = makeApp(s.repo);
    const before = { ch: totalChanges(s.t.db), rows: rowCounts(s.t.db) };
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: "GET", url: "/api/assets/" + s.assetId + "/tree" });
      assert.equal(JSON.parse(res.body).ready, false);
    }
    assert.equal(totalChanges(s.t.db), before.ch);
    assert.deepEqual(rowCounts(s.t.db), before.rows);
    await app.close();
  } finally { s.t.close(); rmSync(s.dir, { recursive: true, force: true }); }
});

test("positive control：真实写入必须被仪器捕获", async () => {
  const s = seed();
  try {
    const before = totalChanges(s.t.db);
    s.repo.replaceArchiveEntries(s.assetId, [{ path: "z.txt", size: 1, isDir: false }]);
    assert.ok(totalChanges(s.t.db) > before, "写入后 total_changes 必须增加（否则零写仪器无判别力）");
  } finally { s.t.close(); rmSync(s.dir, { recursive: true, force: true }); }
});
