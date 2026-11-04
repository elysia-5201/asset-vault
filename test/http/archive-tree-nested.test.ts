/**
 * nested 目录：GET 不 stage；显式 POST 解包（task55 R1）
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
const changes = (db: any) => Number(db.prepare("SELECT total_changes() c").get().c);
const staging = () => readdirSync(tmpdir()).filter((f) => f.startsWith("av-nested-tree-"));

function seed() {
  const t = openTempDb();
  const repo = new Repo(t.db);
  const dir = mkdtempSync(join(tmpdir(), "av-tree-nested-"));
  const inner = buildZip([{ name: "Assets/y.prefab", data: Buffer.from("y") }]);
  const outer = buildZip([{ name: "inner.zip", data: inner }, { name: "readme.txt", data: Buffer.from("r") }]);
  const zipPath = join(dir, "outer.zip");
  writeFileSync(zipPath, outer);
  const rootId = addRoot(t.db, "/lib");
  const itemId = addItem(t.db, { title: "t" });
  const assetId = addAsset(t.db, itemId, rootId, "/lib/outer.zip", { path: zipPath, container: "zip", kind: "archive", size: statSync(zipPath).size });
  return { t, repo, assetId, zipPath, dir };
}

test("GET nested：不 stage、不写库，明确未缓存", async () => {
  const s = seed();
  try {
    const app = makeApp(s.repo);
    const before = { ch: changes(s.t.db), files: staging().length };
    const res = await app.inject({ method: "GET", url: "/api/assets/" + s.assetId + "/tree?nested=inner.zip" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ready, false);
    assert.equal(body.reason, "NESTED_NOT_CACHED");
    assert.deepEqual(body.entries, []);
    assert.equal(changes(s.t.db), before.ch);
    assert.equal(staging().length, before.files, "GET nested 不得产生临时解包文件");
    await app.close();
  } finally { s.t.close(); rmSync(s.dir, { recursive: true, force: true }); }
});

test("POST nested：显式解包功能等价且清理临时文件", async () => {
  const s = seed();
  try {
    const app = makeApp(s.repo);
    const before = { ch: changes(s.t.db), files: staging().length };
    const res = await app.inject({ method: "POST", url: "/api/assets/" + s.assetId + "/tree", payload: { nested: "inner.zip" } });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.container, "nested");
    assert.equal(body.path, "inner.zip");
    assert.deepEqual(body.entries.map((e: any) => e.path), ["Assets/y.prefab"]);
    assert.equal(changes(s.t.db), before.ch, "POST nested 不得写库");
    assert.equal(staging().length, before.files, "临时解包文件必须清理");
    await app.close();
  } finally { s.t.close(); rmSync(s.dir, { recursive: true, force: true }); }
});

test("POST nested：缺失/空/非法 body → 400", async () => {
  const s = seed();
  try {
    const app = makeApp(s.repo);
    for (const payload of [{}, { nested: "" }, { nested: 123 }]) {
      const res = await app.inject({ method: "POST", url: "/api/assets/" + s.assetId + "/tree", payload });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
    }
    await app.close();
  } finally { s.t.close(); rmSync(s.dir, { recursive: true, force: true }); }
});

test("损坏 archive_listing 不得当作合法空 cache", async () => {
  const s = seed();
  try {
    s.repo.setAssetArchiveListing(s.assetId, "{not-json");
    const app = makeApp(s.repo);
    const res = await app.inject({ method: "GET", url: "/api/assets/" + s.assetId + "/tree" });
    const body = JSON.parse(res.body);
    assert.equal(body.ready, false, "损坏 JSON 不是有效 listing");
    assert.equal(body.reason, "CACHE_MISSING");
    await app.close();
  } finally { s.t.close(); rmSync(s.dir, { recursive: true, force: true }); }
});

test("unitypackage 容器：tree 不假装已索引", async () => {
  const s = seed();
  try {
    const db = s.t.db;
    db.prepare("UPDATE assets SET container='unitypackage', kind='unitypackage' WHERE id=?").run(s.assetId);
    const app = makeApp(s.repo);
    const res = await app.inject({ method: "GET", url: "/api/assets/" + s.assetId + "/tree" });
    const body = JSON.parse(res.body);
    assert.equal(body.ready, false);
    assert.equal(body.reason, "NOT_APPLICABLE");
    assert.equal(body.completeness, "not-applicable");
    await app.close();
  } finally { s.t.close(); rmSync(s.dir, { recursive: true, force: true }); }
});
