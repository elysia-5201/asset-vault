/**
 * P1-T5 集成接线（task34）：真实 root registerRoutes + Fastify.inject，不 listen、不碰 7317/生产库。
 *
 * 覆盖：
 *  - 三个新路由模块经 registerRoutes 真实可达（precheck/loadouts/cleanup/commit/version-links）；
 *  - /api/import/paths 委托 createImportPathJobs：files 新形状带 expected，paths 旧形状 legacy:true；
 *  - /api/import/download 的 stage=true 提前分支（root 来自可信配置，body 不能改写）；
 *  - /api/items/:id/assets 的 expected 强验 + 严格 owner 门（正例/陈旧/跨 owner/同 owner 幂等/legacy）；
 *  - /api/import/download/commit 与 stage 共用同一 codec（注入已知 codec 后真实提交 + 重放）；
 *  - Repo.mergeItems 同事务组合 mergeLoadoutItemsTx + mergeCleanupIgnoresTx，真故障整体回滚。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openTempDb, addItem, addAvatar, addAsset, addRoot, count, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerRoutes } from "../../apps/server/src/http/routes";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";
import { createStageTokenCodec } from "../../apps/server/src/services/stage-token";
import { sha256FileChunked } from "../../packages/core/src/hash";

const json = (r: { body: string }): any => JSON.parse(r.body);

function setup(t: TempDb, opts: { codec?: ReturnType<typeof createStageTokenCodec>; dataDir?: string } = {}) {
  const repo = new Repo(t.db);
  const app = Fastify({ logger: false });
  registerRoutes(app as any, {
    repo,
    media: {} as any,
    booth: {} as any,
    runner: {} as any,
    log: () => {},
    version: "test",
    dbPath: t.file,
    dataDir: opts.dataDir ?? t.dir,
    pipeline: null,
    limits: resolveLimits({}),
    stageCodec: opts.codec,
  } as any);
  return { repo, app };
}

function tempFile(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

function expectedOf(p: string): { size: number; mtime: string } {
  const st = statSync(p);
  return { size: st.size, mtime: st.mtime.toISOString() };
}

test("三条新路由经 registerRoutes 真实可达（root 注册，不是 stub）", async () => {
  const t = openTempDb();
  try {
    const { app } = setup(t);
    const av = addAvatar(t.db, "A");
    const it = addItem(t.db, { title: "i" });

    const pre = await app.inject({ method: "POST", url: "/api/import/precheck", payload: {} });
    assert.equal(pre.statusCode, 400);
    assert.equal(json(pre).error.code, "INVALID_INPUT");

    const lo = await app.inject({ method: "GET", url: "/api/avatars/" + av + "/loadouts" });
    assert.equal(lo.statusCode, 200);
    assert.deepEqual(json(lo).loadouts, []);

    const cl = await app.inject({ method: "GET", url: "/api/cleanup/todos" });
    assert.equal(cl.statusCode, 400);
    assert.equal(json(cl).error.details.code, "LOCAL_POLICY_REQUIRED");
    const cl2 = await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=include_local" });
    assert.equal(cl2.statusCode, 200);
    assert.equal(typeof json(cl2).total, "number");

    const commit = await app.inject({ method: "POST", url: "/api/import/download/commit", payload: {} });
    assert.equal(commit.statusCode, 400);
    assert.equal(json(commit).error.code, "INVALID_INPUT");

    const vl = await app.inject({ method: "GET", url: "/api/items/" + it + "/version-links" });
    assert.equal(vl.statusCode, 200);
    assert.equal(json(vl).itemId, it);
    assert.deepEqual(json(vl).links, []);
  } finally { t.close(); }
});

test("/api/import/paths 委托 createImportPathJobs：files 带 expected，paths 旧形状 legacy", async () => {
  const t = openTempDb();
  try {
    const { app } = setup(t);
    const dir = mkdtempSync(join(tmpdir(), "av-wiring-paths-"));
    try {
      const a = tempFile(dir, "a.zip", "aaa");
      const b = tempFile(dir, "b.zip", "bbbb");
      const files = await app.inject({
        method: "POST", url: "/api/import/paths",
        payload: { files: [{ path: a, expected: expectedOf(a) }, { path: b, expected: expectedOf(b) }] },
      });
      assert.equal(files.statusCode, 200);
      const body = json(files);
      assert.equal(body.legacy, false);
      assert.equal(body.jobIds.length, 2);
      assert.deepEqual(body.duplicates, []);
      const jobs = t.db.prepare("SELECT kind, payload FROM jobs WHERE id IN (?,?) ORDER BY id").all(...body.jobIds) as any[];
      assert.equal(jobs.length, 2);
      assert.equal(jobs[0].kind, "import_file");
      const payload = JSON.parse(jobs[0].payload);
      assert.equal(payload.path, a);
      assert.equal(payload.expected.size, 3);
      assert.equal(payload.expected.mtime, expectedOf(a).mtime);
      assert.equal("legacy" in payload, false);

      const legacy = await app.inject({ method: "POST", url: "/api/import/paths", payload: { paths: [a] } });
      assert.equal(legacy.statusCode, 200);
      assert.equal(json(legacy).legacy, true);
      const lp = JSON.parse((t.db.prepare("SELECT payload FROM jobs WHERE id=?").get(json(legacy).jobIds[0]) as any).payload);
      assert.equal(lp.legacy, true);

      const noExpected = await app.inject({ method: "POST", url: "/api/import/paths", payload: { files: [{ path: a }] } });
      assert.equal(noExpected.statusCode, 400);
      assert.equal(json(noExpected).error.details.code, "EXPECTED_REQUIRED");

      const dirAsFile = await app.inject({ method: "POST", url: "/api/import/paths", payload: { files: [{ path: dir, expected: { size: 0, mtime: new Date().toISOString() } }] } });
      assert.equal(dirAsFile.statusCode, 400);
      assert.equal(json(dirAsFile).error.details.code, "DIRECTORY_NOT_ALLOWED_WITH_FILES");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  } finally { t.close(); }
});

test("/api/items/:id/assets：expected 强验 + 严格 owner 门（正例/陈旧/跨 owner/同 owner 幂等/legacy）", async () => {
  const t = openTempDb();
  try {
    const { app } = setup(t);
    const rootId = addRoot(t.db, "/lib");
    const itemA = addItem(t.db, { title: "A" });
    const itemB = addItem(t.db, { title: "B" });
    const dir = mkdtempSync(join(tmpdir(), "av-wiring-assets-"));
    try {
      const fresh = tempFile(dir, "fresh.zip", "fresh-bytes");
      const exp = expectedOf(fresh);

      // 正例：新文件 + 正确 expected → 登记 1 个 asset，归属目标 item。
      const ok = await app.inject({ method: "POST", url: "/api/items/" + itemA + "/assets", payload: { path: fresh, expected: exp } });
      assert.equal(ok.statusCode, 200);
      const okBody = json(ok);
      assert.equal(okBody.added, 1);
      assert.equal(okBody.assetIds.length, 1);
      const assetId = okBody.assetIds[0];
      const row = t.db.prepare("SELECT item_id, path_norm, size FROM assets WHERE id=?").get(assetId) as any;
      assert.equal(row.item_id, itemA);
      assert.equal(row.size, exp.size);

      // 同 owner 幂等：再提交一次 → added 0，不新增 asset，不换 owner。
      const again = await app.inject({ method: "POST", url: "/api/items/" + itemA + "/assets", payload: { path: fresh, expected: exp } });
      assert.equal(again.statusCode, 200);
      assert.equal(json(again).added, 0);
      assert.deepEqual(json(again).assetIds, []);
      assert.equal(count(t.db, "assets", "path_norm=?", row.path_norm), 1);
      assert.equal((t.db.prepare("SELECT item_id FROM assets WHERE id=?").get(assetId) as any).item_id, itemA);

      // 陈旧：size 不符 → 409 PRECHECK_STALE，零 item/asset/job 副作用。
      const assetsBefore = count(t.db, "assets");
      const jobsBefore = count(t.db, "jobs");
      const itemsBefore = count(t.db, "items");
      const stale = await app.inject({
        method: "POST", url: "/api/items/" + itemA + "/assets",
        payload: { path: fresh, expected: { size: exp.size + 1, mtime: exp.mtime } },
      });
      assert.equal(stale.statusCode, 409);
      assert.equal(json(stale).error.code, "CONFLICT");
      assert.equal(json(stale).error.details.code, "PRECHECK_STALE");
      assert.equal(count(t.db, "assets"), assetsBefore);
      assert.equal(count(t.db, "jobs"), jobsBefore);
      assert.equal(count(t.db, "items"), itemsBefore);

      // 跨 owner：路径已属于 itemB，向 itemA 登记 → 409 PATH_OWNED_BY_OTHER_ITEM + details，owner 不变。
      const owned = tempFile(dir, "owned.zip", "owned-bytes");
      const ownedExp = expectedOf(owned);
      const first = await app.inject({ method: "POST", url: "/api/items/" + itemB + "/assets", payload: { path: owned, expected: ownedExp } });
      assert.equal(first.statusCode, 200);
      const ownedAssetId = json(first).assetIds[0];
      const foreign = await app.inject({ method: "POST", url: "/api/items/" + itemA + "/assets", payload: { path: owned, expected: ownedExp } });
      assert.equal(foreign.statusCode, 409);
      assert.equal(json(foreign).error.details.code, "PATH_OWNED_BY_OTHER_ITEM");
      assert.equal(json(foreign).error.details.itemId, itemB);
      assert.equal(json(foreign).error.details.assetId, ownedAssetId);
      assert.equal((t.db.prepare("SELECT item_id FROM assets WHERE id=?").get(ownedAssetId) as any).item_id, itemB);
      assert.equal(count(t.db, "assets", "path_norm=?", (t.db.prepare("SELECT path_norm FROM assets WHERE id=?").get(ownedAssetId) as any).path_norm), 1);

      // legacy（无 expected）：新文件仍按旧行为登记；跨 owner 仍被 owner 门拦下（禁止静默迁移）。
      const legacyFile = tempFile(dir, "legacy.zip", "legacy-bytes");
      const legacy = await app.inject({ method: "POST", url: "/api/items/" + itemA + "/assets", payload: { path: legacyFile } });
      assert.equal(legacy.statusCode, 200);
      assert.equal(json(legacy).added, 1);
      const legacyForeign = await app.inject({ method: "POST", url: "/api/items/" + itemA + "/assets", payload: { path: owned } });
      assert.equal(legacyForeign.statusCode, 409);
      assert.equal(json(legacyForeign).error.details.code, "PATH_OWNED_BY_OTHER_ITEM");
      assert.equal((t.db.prepare("SELECT item_id FROM assets WHERE id=?").get(ownedAssetId) as any).item_id, itemB);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  } finally { t.close(); }
});

test("/api/import/download stage=true 提前分支：root 来自可信配置，body 不能改写，且不建 item/asset/job", async () => {
  const t = openTempDb();
  try {
    const dataDir = mkdtempSync(join(tmpdir(), "av-wiring-stage-"));
    try {
      const { app } = setup(t, { dataDir });
      const itemsBefore = count(t.db, "items");
      const assetsBefore = count(t.db, "assets");
      const jobsBefore = count(t.db, "jobs");

      const mismatch = await app.inject({
        method: "POST", url: "/api/import/download",
        payload: { stage: true, url: "https://booth.pm/downloadables/1", downloadRoot: "/tmp/not-the-configured-root" },
      });
      assert.equal(mismatch.statusCode, 400);
      assert.equal(json(mismatch).error.code, "INVALID_INPUT");
      assert.ok(String(json(mismatch).error.message).includes("下载根"), json(mismatch).error.message);

      // 非 BOOTH 地址在 stage 分支同样 400（不落盘、不登记）。
      const badUrl = await app.inject({ method: "POST", url: "/api/import/download", payload: { stage: true, url: "https://example.com/a.zip" } });
      assert.equal(badUrl.statusCode, 400);

      assert.equal(count(t.db, "items"), itemsBefore);
      assert.equal(count(t.db, "assets"), assetsBefore);
      assert.equal(count(t.db, "jobs"), jobsBefore);
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  } finally { t.close(); }
});

test("/api/import/download/commit 与 stage 共用同一 codec：真实提交 + 重放 + skip", async () => {
  const t = openTempDb();
  const dir = mkdtempSync(join(tmpdir(), "av-wiring-commit-"));
  try {
    const codec = createStageTokenCodec(Buffer.from("wiring-key"), "ep-wiring");
    const { app } = setup(t, { codec, dataDir: dir });
    const file = tempFile(dir, "staged.zip", "staged-bytes");
    const st = statSync(file);
    const hash = (await sha256FileChunked(file)).sha256;
    const token = codec.issue({
      p: file, r: dir, i: null, s: st.size, m: st.mtime.toISOString(), h: hash,
      e: Date.now() + 60_000, n: randomUUID(),
    });

    const imported = await app.inject({ method: "POST", url: "/api/import/download/commit", payload: { stageToken: token, decision: "import" } });
    assert.equal(imported.statusCode, 200);
    const body = json(imported);
    assert.equal(body.decision, "import");
    assert.equal(body.replayed, false);
    assert.equal(typeof body.itemId, "number");
    assert.equal(typeof body.assetId, "number");
    const asset = t.db.prepare("SELECT item_id, path_norm, discovered_by FROM assets WHERE id=?").get(body.assetId) as any;
    assert.equal(asset.item_id, body.itemId);
    assert.equal(asset.discovered_by, "download");

    const replay = await app.inject({ method: "POST", url: "/api/import/download/commit", payload: { stageToken: token, decision: "import" } });
    assert.equal(replay.statusCode, 200);
    assert.equal(json(replay).replayed, true);
    assert.equal(json(replay).itemId, body.itemId);
    assert.equal(json(replay).assetId, body.assetId);

    const skipFile = tempFile(dir, "skip.zip", "skip-bytes");
    const skipSt = statSync(skipFile);
    const skipToken = codec.issue({
      p: skipFile, r: dir, i: null, s: skipSt.size, m: skipSt.mtime.toISOString(),
      h: (await sha256FileChunked(skipFile)).sha256, e: Date.now() + 60_000, n: randomUUID(),
    });
    const skipped = await app.inject({ method: "POST", url: "/api/import/download/commit", payload: { stageToken: skipToken, decision: "skip" } });
    assert.equal(skipped.statusCode, 200);
    assert.equal(json(skipped).skipped, true);
    assert.equal(count(t.db, "assets", "path_norm=?", skipFile), 0);

    // 另一个 codec 签的 token 不被接受（证明 root 用的是同一个 codec 实例）。
    const other = createStageTokenCodec(Buffer.from("other-key"), "ep-wiring");
    const foreignToken = other.issue({
      p: file, r: dir, i: null, s: st.size, m: st.mtime.toISOString(), h: hash,
      e: Date.now() + 60_000, n: randomUUID(),
    });
    const rejected = await app.inject({ method: "POST", url: "/api/import/download/commit", payload: { stageToken: foreignToken, decision: "import" } });
    assert.equal(rejected.statusCode, 410);
    assert.equal(json(rejected).error.details.code, "STAGE_TOKEN_INVALID");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    t.close();
  }
});

test("Repo.mergeItems 同事务组合两个 merge hook：清单冲突/忽略迁移 + 审计", async () => {
  const t = openTempDb();
  try {
    const repo = new Repo(t.db);
    const av = addAvatar(t.db, "A");
    const src = addItem(t.db, { title: "src" });
    const tgt = addItem(t.db, { title: "tgt" });
    const now = new Date().toISOString();
    const lid = Number(t.db.prepare("INSERT INTO loadouts(avatar_id,name,sort,version,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(av, "L", 0, 1, now, now).lastInsertRowid);
    t.db.prepare("INSERT INTO loadout_items(loadout_id,item_id,state,note,position,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(lid, src, "planned", "s", 0, 1, now, now);
    t.db.prepare("INSERT INTO loadout_items(loadout_id,item_id,state,note,position,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(lid, tgt, "verified", "t", 1, 2, now, now);
    t.db.prepare("INSERT INTO cleanup_ignores(item_id,rule,note,ignored_at) VALUES (?,?,?,?)")
      .run(src, "missing_cover", "n", now);

    const out = repo.mergeItems(src, tgt);
    assert.equal(out.movedAssets, 0);
    assert.equal(out.loadoutMerge.conflicts, 1);
    assert.equal(out.cleanupIgnoresMoved, 1);

    const srcRow = t.db.prepare("SELECT deleted_at, version FROM loadout_items WHERE loadout_id=? AND item_id=?").get(lid, src) as any;
    assert.ok(srcRow.deleted_at, "source 清单项应转墓碑");
    const tgtRow = t.db.prepare("SELECT state, version FROM loadout_items WHERE loadout_id=? AND item_id=?").get(lid, tgt) as any;
    assert.equal(tgtRow.state, "verified", "target 赢 state");
    assert.equal(tgtRow.version, 3, "target version = max(2,1)+1");
    assert.equal(count(t.db, "cleanup_ignores", "item_id=?", src), 0);
    assert.equal(count(t.db, "cleanup_ignores", "item_id=?", tgt), 1);
    assert.ok(count(t.db, "audit_log", "action=?", "loadout.merge_conflict") >= 1);
    assert.ok(count(t.db, "audit_log", "action=?", "merge.cleanup_ignores_moved") >= 1);
    assert.equal((t.db.prepare("SELECT status FROM items WHERE id=?").get(src) as any).status, "trashed");
  } finally { t.close(); }
});

test("Repo.mergeItems 真故障（源条目软删触发器 ABORT）→ 清单/忽略/资产/审计整体回滚", async () => {
  const t = openTempDb();
  try {
    const repo = new Repo(t.db);
    const rootId = addRoot(t.db, "/lib");
    const av = addAvatar(t.db, "A");
    const src = addItem(t.db, { title: "src" });
    const tgt = addItem(t.db, { title: "tgt" });
    addAsset(t.db, src, rootId, "/lib/src.zip");
    const now = new Date().toISOString();
    const lid = Number(t.db.prepare("INSERT INTO loadouts(avatar_id,name,sort,version,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(av, "L", 0, 1, now, now).lastInsertRowid);
    t.db.prepare("INSERT INTO loadout_items(loadout_id,item_id,state,note,position,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(lid, src, "planned", "s", 0, 1, now, now);
    t.db.prepare("INSERT INTO cleanup_ignores(item_id,rule,note,ignored_at) VALUES (?,?,?,?)")
      .run(src, "missing_cover", "n", now);
    t.db.exec("CREATE TRIGGER fail_merge BEFORE UPDATE OF status ON items WHEN NEW.status='trashed' BEGIN SELECT RAISE(ABORT,'boom'); END");

    assert.throws(() => repo.mergeItems(src, tgt), /boom/);

    assert.equal((t.db.prepare("SELECT status FROM items WHERE id=?").get(src) as any).status, "inbox");
    assert.equal((t.db.prepare("SELECT item_id FROM assets WHERE path_norm=?").get("/lib/src.zip") as any).item_id, src);
    const srcRow = t.db.prepare("SELECT deleted_at, version FROM loadout_items WHERE loadout_id=? AND item_id=?").get(lid, src) as any;
    assert.equal(srcRow.deleted_at, null);
    assert.equal(srcRow.version, 1);
    const tgtRow = t.db.prepare("SELECT version FROM loadout_items WHERE loadout_id=? AND item_id=?").get(lid, tgt) as any;
    assert.equal(tgtRow, undefined, "target 行不应被创建");
    assert.equal(count(t.db, "cleanup_ignores", "item_id=?", src), 1);
    assert.equal(count(t.db, "cleanup_ignores", "item_id=?", tgt), 0);
    assert.equal(count(t.db, "audit_log", "action=?", "loadout.merge_conflict"), 0);
    assert.equal(count(t.db, "audit_log", "action=?", "merge.cleanup_ignores_moved"), 0);
  } finally { t.close(); }
});
