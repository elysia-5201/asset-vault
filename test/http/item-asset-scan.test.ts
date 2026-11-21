import assert from "node:assert/strict";
import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { Repo } from "../../apps/server/src/db/repo";
import { registerRoutes, type RouteDeps } from "../../apps/server/src/http/routes";
import type { ItemAssetScanResult } from "../../packages/core/src/contracts";
import { normalizePath } from "../../packages/core/src/pathnorm";
import { addAsset, addItem, addRoot, openTempDb } from "../schema/_db";

test("单条扫描只核对登记路径，保留同名新文件、失联磁盘记录和其他条目", async () => {
  const temp = openTempDb();
  const { db, dir } = temp;
  const repo = new Repo(db);
  const app = Fastify();
  registerRoutes(app, {
    repo, media: {} as RouteDeps["media"], booth: {} as RouteDeps["booth"], runner: {} as RouteDeps["runner"],
    log: () => {}, version: "test", dbPath: temp.file, dataDir: dir,
  });
  try {
    const item = addItem(db);
    const otherItem = addItem(db);
    const root = addRoot(db, normalizePath(dir), dir);
    const offlineDir = join(dir, "offline");
    const offlineRoot = addRoot(db, normalizePath(offlineDir), offlineDir);
    const oldPath = join(dir, "old", "material.zip");
    const newPath = join(dir, "new", "material.zip");
    const offlinePath = join(offlineDir, "material.zip");
    mkdirSync(join(dir, "old"));
    mkdirSync(join(dir, "new"));
    writeFileSync(oldPath, "test asset");
    const st = statSync(oldPath);
    const fingerprint = { size: st.size, mtime: st.mtime.toISOString() };
    const oldId = addAsset(db, item, root, normalizePath(oldPath), { path: oldPath, ...fingerprint });
    renameSync(oldPath, newPath);
    const newId = addAsset(db, item, root, normalizePath(newPath), { path: newPath, ...fingerprint });
    const offlineId = addAsset(db, item, offlineRoot, normalizePath(offlinePath), { path: offlinePath });
    const otherId = addAsset(db, otherItem, root, normalizePath(join(dir, "other.zip")));
    const trashedId = addAsset(db, item, root, normalizePath(join(dir, "trashed.zip")), { status: "trashed" });
    const scan = () => app.inject({ method: "POST", url: "/api/items/" + item + "/assets/scan" });
    assert.equal((await app.inject({ method: "POST", url: "/api/items/" + item + "bad/assets/scan" })).statusCode, 400);
    assert.equal(repo.getAsset(oldId)?.status, "present");

    const response = await scan();
    assert.equal(response.statusCode, 200, response.body);
    const { files } = response.json<ItemAssetScanResult>();
    assert.deepEqual(files.map(({ assetId, state, changed }) => ({ assetId, state, changed })), [
      { assetId: oldId, state: "missing", changed: true },
      { assetId: newId, state: "present", changed: false },
      { assetId: offlineId, state: "unavailable", changed: false },
    ]);
    assert.equal(repo.getAsset(oldId)?.status, "missing");
    assert.equal(repo.getAsset(newId)?.status, "present");
    assert.equal(repo.getAsset(offlineId)?.status, "present");
    assert.equal(repo.getAsset(otherId)?.status, "present");
    assert.equal(repo.getAsset(trashedId)?.status, "trashed");
    assert.deepEqual(db.prepare("SELECT id FROM jobs").all(), []);
    assert.equal(statSync(newPath).size, st.size);
    assert.equal((await scan()).json<ItemAssetScanResult>().files.some((file) => file.changed), false);

    writeFileSync(oldPath, "different file now");
    const changed = (await scan()).json<ItemAssetScanResult>().files.find((file) => file.assetId === oldId);
    assert.equal(changed?.state, "unavailable");
    assert.equal(repo.getAsset(oldId)?.status, "missing");
    const parked = join(dir, "parked.zip");
    renameSync(oldPath, parked);
    renameSync(newPath, oldPath);
    await scan();
    assert.equal(repo.getAsset(oldId)?.status, "present");
    assert.equal(repo.getAsset(newId)?.status, "missing");
    assert.equal((await app.inject({ method: "POST", url: "/api/items/999999/assets/scan" })).statusCode, 404);
  } finally {
    await app.close();
    temp.close();
  }
});

test("路径检查结果不会覆盖扫描期间已移动的资产", () => {
  const temp = openTempDb();
  try {
    const { db, dir } = temp;
    const repo = new Repo(db);
    const item = addItem(db);
    const newOwner = addItem(db);
    const root = addRoot(db, normalizePath(dir), dir);
    const id = addAsset(db, item, root, normalizePath(join(dir, "package.zip")));
    const before = repo.getAsset(id)!;
    repo.moveAssets(item, newOwner);
    assert.equal(repo.applyAssetPathChecks([{ asset: before, status: "missing" }]).size, 0);
    assert.equal(repo.getAsset(id)?.status, "present");
  } finally {
    temp.close();
  }
});
