/**
 * Task 2：接受列表导入与 expected 重验（spec §6.3 / §9.1）。
 * 只连临时 DB 与临时文件；不碰 7317 / data / 真实素材。
 *
 * Ruling 13 修正（fix round 1）：
 *  - 新 files/expected 形状：跨 owner（含未知新 target）→ 该文件 failed（PATH_OWNED_BY_OTHER_ITEM），
 *    不是 skip、不是复用他人 owner；已知 same owner 幂等。
 *  - legacy paths/目录/apply：无 version links 的旧状态保持原 runner 行为（含旧 upsert 改 owner 语义）。
 *  - §9.1：只有“跨 owner 且该 asset 有 version links”才 skip + asset_owner_conflict_skipped。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openTempDb, addRoot, addItem, addAsset, count, NOW } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { normalizePath } from "../../packages/core/src/pathnorm";
import { runJob } from "../../apps/server/src/jobs/runner";
import { createImportPathJobs, verifyAcceptedFile, verifyExpectedOrThrow, shouldSkipForOwnerConflict } from "../../apps/server/src/services/import-files";

/** 建一条同 item 的版本关系（asset_a_id < asset_b_id 由 schema 约束）。 */
function linkAssets(db: any, itemId: number, aId: number, bId: number): void {
  const [a, b] = aId < bId ? [aId, bId] : [bId, aId];
  db.prepare(
    "INSERT INTO asset_version_links(item_id, asset_a_id, asset_b_id, relation, basis, state, version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(itemId, a, b, "same", "manual", "candidate", 1, NOW, NOW);
}

test("files 形状：目录/缺 expected 拒绝，重复路径去重", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const dir = mkdtempSync(join(tmpdir(), "av-acc-"));
  const f = join(dir, "a.zip"); writeFileSync(f, "A");
  const exp = { size: 1, mtime: statSync(f).mtime.toISOString() };
  assert.throws(() => createImportPathJobs({ repo }, { files: [{ path: dir, expected: exp }] }), (e: any) => e.details?.code === "DIRECTORY_NOT_ALLOWED_WITH_FILES");
  assert.throws(() => createImportPathJobs({ repo }, { files: [{ path: f } as any] }), (e: any) => e.details?.code === "EXPECTED_REQUIRED");
  const r = createImportPathJobs({ repo }, { files: [{ path: f, expected: exp }, { path: f, expected: exp }] });
  assert.equal(r.jobIds.length, 1); assert.deepEqual(r.duplicates, [f]); assert.equal(r.legacy, false);
  assert.deepEqual(JSON.parse(repo.getJob(r.jobIds[0])!.payload!).expected, exp);
  rmSync(dir, { recursive: true, force: true }); t.close();
});

test("copy destination and explicit BOOTH link are bound to the same accepted-file job", async () => {
  const t = openTempDb();
  const repo = new Repo(t.db);
  const dir = mkdtempSync(join(tmpdir(), "av-import-dest-"));
  try {
    const destination = join(dir, "library");
    mkdirSync(destination);
    const file = (name: string, bytes: string) => {
      const path = join(dir, name);
      writeFileSync(path, bytes);
      const info = statSync(path);
      return { path, expected: { size: info.size, mtime: info.mtime.toISOString() } };
    };
    const files = [file("Body.zip", "body"), file("Face.zip", "face")];
    assert.throws(() => createImportPathJobs({ repo }, { files, destination, boothUrl: "https://booth.pm/downloadables/12345" }), /BOOTH/);
    assert.throws(() => createImportPathJobs({ repo }, { files, destination: join(dir, "absent") }), /导入目录/);
    assert.equal(count(t.db, "jobs"), 0);
    assert.throws(() => createImportPathJobs({ repo }, { files: [files[0], { ...files[1], expected: undefined } as any], destination }), /expected/);
    assert.equal(count(t.db, "jobs"), 0, "a bad second file cannot leave the first job queued");

    const deps = { repo, media: {} as any, booth: { fetchItem: async () => { throw new Error("offline fixture"); } } as any, log: () => {} };
    const batch = { files, destination, boothUrl: "https://example.booth.pm/items/9081929" };
    const accepted = createImportPathJobs({ repo }, batch);
    for (const id of accepted.jobIds) {
      await runJob(deps, id);
      assert.equal(repo.getJob(id)?.state, "done");
    }
    const item = repo.getItemBySource("booth", "9081929")!;
    assert.ok(item);
    assert.equal(item.source_url, "https://booth.pm/ja/items/9081929");
    assert.equal(count(t.db, "items"), 1);
    assert.equal(count(t.db, "assets"), 2);
    assert.ok(existsSync(files[0].path));
    assert.equal(readFileSync(join(destination, "Body.zip"), "utf8"), "body");
    const importedFace = repo.listAssets(item.id).find((asset) => basename(asset.path) === "Face.zip");
    assert.ok(importedFace);
    assert.equal(importedFace.path_norm, normalizePath(join(destination, "Face.zip")));
    assert.equal(statSync(importedFace.path).ino, statSync(join(destination, "Face.zip")).ino);
    assert.equal(repo.getAssetByPathNorm(normalizePath(files[1].path)), null);

    const changed = file("Face.zip", "different");
    const conflict = createImportPathJobs({ repo }, { ...batch, files: [changed] }).jobIds[0];
    await runJob(deps, conflict);
    assert.equal(repo.getJob(conflict)?.state, "failed");
    assert.equal(readFileSync(join(destination, "Face.zip"), "utf8"), "face");
  } finally {
    t.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expected 不匹配 → PRECHECK_STALE；路径占用 → 409；shouldSkip 只在 linked 跨 owner 时 true", async () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const dir = mkdtempSync(join(tmpdir(), "av-acc2-"));
  const f = join(dir, "b.zip"); writeFileSync(f, "BB");
  const exp = { size: 2, mtime: statSync(f).mtime.toISOString(), sha256: "0".repeat(64) };
  const bad = await verifyAcceptedFile({ repo }, { path: f, expected: exp });
  assert.deepEqual(bad, { ok: false, reason: "PRECHECK_STALE" });
  const good = await verifyAcceptedFile({ repo }, { path: f, expected: { size: 2, mtime: exp.mtime } });
  assert.deepEqual(good, { ok: true, verified: "metadata" });
  const owner = addItem(t.db, { title: "owner" }); const other = addItem(t.db, { title: "other" });
  const ownedId = addAsset(t.db, owner, rootId, normalizePath(f), { path: f, path_norm: normalizePath(f), size: 2 });
  await assert.rejects(() => verifyExpectedOrThrow({ repo }, other, f, { size: 2, mtime: exp.mtime }),
    (e: any) => e.code === "CONFLICT" && e.status === 409 && e.details?.code === "PATH_OWNED_BY_OTHER_ITEM" && e.details?.itemId === owner && e.details?.assetId === ownedId);
  // 无 version links：跨 owner 不 skip（旧 upsert 语义）；同 owner 不 skip。
  assert.deepEqual(shouldSkipForOwnerConflict(repo, other, normalizePath(f)), { skip: false });
  assert.deepEqual(shouldSkipForOwnerConflict(repo, owner, normalizePath(f)), { skip: false });
  // 有 version links：只有跨 owner 才 skip。
  const companion = addAsset(t.db, owner, rootId, normalizePath(join(dir, "companion.zip")), { path: join(dir, "companion.zip"), path_norm: normalizePath(join(dir, "companion.zip")), size: 1 });
  linkAssets(t.db, owner, ownedId, companion);
  assert.deepEqual(shouldSkipForOwnerConflict(repo, other, normalizePath(f)), { skip: true, itemId: owner, assetId: ownedId });
  assert.deepEqual(shouldSkipForOwnerConflict(repo, owner, normalizePath(f)), { skip: false });
  assert.equal(count(t.db, "assets"), 2);
  rmSync(dir, { recursive: true, force: true }); t.close();
});

test("runner isFile：expected 不匹配 → precheck_stale 事件 + 作业失败，零 item/asset；匹配则登记", async () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const dir = mkdtempSync(join(tmpdir(), "av-acc3-"));
  const f = join(dir, "c.zip"); writeFileSync(f, "CC");
  const st = statSync(f);
  const deps = { repo, media: {} as any, booth: {} as any, log: () => {} };
  const stale = repo.createJob("import_file", null, { path: f, expected: { size: 99, mtime: st.mtime.toISOString() } }, 5);
  await runJob(deps, stale.id);
  assert.equal(repo.getJob(stale.id)!.state, "failed");
  assert.equal(count(t.db, "items"), 0);
  assert.equal(count(t.db, "assets"), 0);
  assert.ok(repo.listJobEvents(stale.id).some((e: any) => e.event === "precheck_stale"));
  const good = repo.createJob("import_file", null, { path: f, expected: { size: 2, mtime: st.mtime.toISOString() } }, 5);
  await runJob(deps, good.id);
  assert.equal(repo.getJob(good.id)!.state, "done");
  assert.equal(count(t.db, "items"), 1);
  assert.equal(count(t.db, "assets"), 1);
  rmSync(dir, { recursive: true, force: true }); t.close();
});

test("runner registerBatch：linked 跨 item 冲突跳过并记事件；无 link 保持旧 upsert 语义；全拒不建空 item", async () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const deps = { repo, media: {} as any, booth: {} as any, log: () => {} };
  const dir = mkdtempSync(join(tmpdir(), "av-acc4-"));
  const owned = join(dir, "6115428_v1.2.zip"); writeFileSync(owned, "OLD");
  const fresh = join(dir, "6115428_v1.3.zip"); writeFileSync(fresh, "NEW");
  const owner = addItem(t.db, { title: "owner", source_site: "booth", source_item_id: "6115428" });
  const other = addItem(t.db, { title: "other" });
  const ownedId = addAsset(t.db, other, rootId, normalizePath(owned), { path: owned, path_norm: normalizePath(owned), size: 3 });
  const companion = addAsset(t.db, other, rootId, normalizePath(join(dir, "companion.zip")), { path: join(dir, "companion.zip"), path_norm: normalizePath(join(dir, "companion.zip")), size: 1 });
  linkAssets(t.db, other, ownedId, companion);
  const job = repo.createJob("import_file", null, { path: dir }, 5);
  await runJob(deps, job.id);
  assert.equal(repo.getJob(job.id)!.state, "done");
  assert.equal(repo.getAsset(ownedId)!.item_id, other, "linked 老 owner 不被迁走");
  assert.equal(repo.getAssetByPathNorm(normalizePath(fresh))!.item_id, owner, "无冲突文件登记到目标 item");
  assert.equal(count(t.db, "assets"), 3);
  assert.equal(count(t.db, "items"), 2);
  const ev = repo.listJobEvents(job.id).filter((e: any) => e.event === "asset_owner_conflict_skipped");
  assert.equal(ev.length, 1);
  assert.match(String(ev[0].detail), /6115428_v1\.2\.zip/);

  // 全冲突（linked）→ 不建空 item
  const dir2 = mkdtempSync(join(tmpdir(), "av-acc5-"));
  const only = join(dir2, "7777777_v1.0.zip"); writeFileSync(only, "X");
  const other2 = addItem(t.db, { title: "other2" });
  const onlyId = addAsset(t.db, other2, rootId, normalizePath(only), { path: only, path_norm: normalizePath(only), size: 1 });
  const companion2 = addAsset(t.db, other2, rootId, normalizePath(join(dir2, "companion2.zip")), { path: join(dir2, "companion2.zip"), path_norm: normalizePath(join(dir2, "companion2.zip")), size: 1 });
  linkAssets(t.db, other2, onlyId, companion2);
  const job2 = repo.createJob("import_file", null, { path: dir2 }, 5);
  await runJob(deps, job2.id);
  assert.equal(repo.getJob(job2.id)!.state, "done");
  assert.equal(repo.getItemBySource("booth", "7777777"), null, "全冲突组不建空 item");
  assert.equal(count(t.db, "items"), 3);
  assert.equal(count(t.db, "assets"), 5);
  assert.ok(repo.listJobEvents(job2.id).some((e: any) => e.event === "asset_owner_conflict_skipped"));

  // legacy 无 link：旧 upsert 语义（改 owner），不 skip
  const dir3 = mkdtempSync(join(tmpdir(), "av-acc5b-"));
  const legacy = join(dir3, "6115428_v1.4.zip"); writeFileSync(legacy, "LEG");
  const other3 = addItem(t.db, { title: "other3" });
  const legacyId = addAsset(t.db, other3, rootId, normalizePath(legacy), { path: legacy, path_norm: normalizePath(legacy), size: 3 });
  const job3 = repo.createJob("import_file", null, { path: dir3 }, 5);
  await runJob(deps, job3.id);
  assert.equal(repo.getJob(job3.id)!.state, "done");
  assert.equal(repo.getAsset(legacyId)!.item_id, owner, "无 link 的 legacy 文件保持旧 upsert 改 owner 语义");
  assert.equal(repo.listJobEvents(job3.id).filter((e: any) => e.event === "asset_owner_conflict_skipped").length, 0);
  assert.equal(count(t.db, "items"), 4);
  assert.equal(count(t.db, "assets"), 6);
  rmSync(dir, { recursive: true, force: true }); rmSync(dir2, { recursive: true, force: true }); rmSync(dir3, { recursive: true, force: true }); t.close();
});

test("runner files 新形状：local unknown 跨 owner → 作业 failed + 事件，零业务副作用", async () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const deps = { repo, media: {} as any, booth: {} as any, log: () => {} };
  const dir = mkdtempSync(join(tmpdir(), "av-acc6-"));
  const local = join(dir, "random.zip"); writeFileSync(local, "L");
  const other = addItem(t.db, { title: "other" });
  const ownedId = addAsset(t.db, other, rootId, normalizePath(local), { path: local, path_norm: normalizePath(local), size: 1 });
  const st = statSync(local);
  const job = repo.createJob("import_file", null, { path: local, expected: { size: 1, mtime: st.mtime.toISOString() } }, 5);
  await runJob(deps, job.id);
  assert.equal(repo.getJob(job.id)!.state, "failed");
  assert.equal(count(t.db, "items"), 1);
  assert.equal(count(t.db, "assets"), 1);
  assert.equal(repo.getAsset(ownedId)!.item_id, other, "老 owner 不变");
  const ev = repo.listJobEvents(job.id).filter((e: any) => e.event === "asset_owner_conflict_failed");
  assert.equal(ev.length, 1);
  const d = JSON.parse(String(ev[0].detail));
  assert.equal(d.reason, "PATH_OWNED_BY_OTHER_ITEM");
  assert.equal(d.itemId, other);
  assert.equal(d.assetId, ownedId);
  rmSync(dir, { recursive: true, force: true }); t.close();
});

test("runner files 新形状：BOOTH 已知/未知 target 跨 owner → failed，不建 item/asset", async () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const deps = { repo, media: {} as any, booth: {} as any, log: () => {} };
  const dir = mkdtempSync(join(tmpdir(), "av-acc7-"));
  // 已知 target：booth item 已存在，路径被别的 item 占用
  const f1 = join(dir, "6115428_v1.2.zip"); writeFileSync(f1, "B");
  const boothItem = addItem(t.db, { title: "booth", source_site: "booth", source_item_id: "6115428" });
  const other = addItem(t.db, { title: "other" });
  const owned1 = addAsset(t.db, other, rootId, normalizePath(f1), { path: f1, path_norm: normalizePath(f1), size: 1 });
  const st1 = statSync(f1);
  const job1 = repo.createJob("import_file", null, { path: f1, expected: { size: 1, mtime: st1.mtime.toISOString() } }, 5);
  await runJob(deps, job1.id);
  assert.equal(repo.getJob(job1.id)!.state, "failed");
  assert.equal(repo.getAsset(owned1)!.item_id, other, "老 owner 不变");
  assert.equal(count(t.db, "items"), 2);
  assert.equal(count(t.db, "assets"), 1);
  assert.ok(repo.listJobEvents(job1.id).some((e: any) => e.event === "asset_owner_conflict_failed"));

  // 未知 target：booth item 不存在，路径被别的 item 占用 → 不建 booth item
  const f2 = join(dir, "9999999_v1.0.zip"); writeFileSync(f2, "U");
  const other2 = addItem(t.db, { title: "other2" });
  const owned2 = addAsset(t.db, other2, rootId, normalizePath(f2), { path: f2, path_norm: normalizePath(f2), size: 1 });
  const st2 = statSync(f2);
  const job2 = repo.createJob("import_file", null, { path: f2, expected: { size: 1, mtime: st2.mtime.toISOString() } }, 5);
  await runJob(deps, job2.id);
  assert.equal(repo.getJob(job2.id)!.state, "failed");
  assert.equal(repo.getItemBySource("booth", "9999999"), null, "未知新 target 不建空 item");
  assert.equal(repo.getAsset(owned2)!.item_id, other2, "老 owner 不变");
  assert.equal(count(t.db, "items"), 3);
  assert.equal(count(t.db, "assets"), 2);
  rmSync(dir, { recursive: true, force: true }); t.close();
});

test("runner files 新形状：已知 same owner 幂等（不新建 item/asset，不报冲突）", async () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const deps = { repo, media: {} as any, booth: {} as any, log: () => {} };
  const dir = mkdtempSync(join(tmpdir(), "av-acc8-"));
  const f = join(dir, "6115428_v1.2.zip"); writeFileSync(f, "S");
  const boothItem = addItem(t.db, { title: "booth", source_site: "booth", source_item_id: "6115428" });
  const ownedId = addAsset(t.db, boothItem, rootId, normalizePath(f), { path: f, path_norm: normalizePath(f), size: 1 });
  const st = statSync(f);
  const job = repo.createJob("import_file", null, { path: f, expected: { size: 1, mtime: st.mtime.toISOString() } }, 5);
  await runJob(deps, job.id);
  assert.equal(repo.getJob(job.id)!.state, "done");
  assert.equal(count(t.db, "items"), 1);
  assert.equal(count(t.db, "assets"), 1);
  assert.equal(repo.getAsset(ownedId)!.item_id, boothItem);
  assert.equal(repo.listJobEvents(job.id).filter((e: any) => e.event === "asset_owner_conflict_failed").length, 0);
  rmSync(dir, { recursive: true, force: true }); t.close();
});
