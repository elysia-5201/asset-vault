/**
 * task-49：POST /api/import-plans 跨 item 分组建计划。
 * 单 item 保持 {plan,items,precheck}；跨 item 返回 {plans:[...]}；组内失败隔离。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { openTempDb, addItem, addRoot, addAsset, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerRoutes } from "../../apps/server/src/http/routes";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";

let t: TempDb; let repo: Repo; let rootId: number; let dir: string;
beforeEach(() => {
  t = openTempDb(); repo = new Repo(t.db); rootId = addRoot(t.db, "/lib"); dir = mkdtempSync(join(tmpdir(), "av-batch-"));
});
afterEach(() => { t.close(); rmSync(dir, { recursive: true, force: true }); });

const app = () => {
  const a = Fastify({ logger: false });
  registerRoutes(a as any, {
    repo, media: {} as any, booth: {} as any, runner: {} as any, log: () => {}, version: "test",
    dbPath: join(dir, "t.db"), dataDir: dir, pipeline: null, limits: resolveLimits({}),
  } as any);
  return a;
};
function unitOf(title: string, importable = true) {
  const itemId = addItem(t.db, { title });
  const path = join(dir, title + ".unitypackage");
  writeFileSync(path, Buffer.alloc(8, 1));
  const assetId = addAsset(t.db, itemId, rootId, path, { kind: "unitypackage", container: "unitypackage", path, path_norm: path, size: 8, mtime: "2026-10-02T00:00:00.000Z" });
  const fp = "8:2026-10-02T00:00:00.000Z:";
  const ids = repo.replaceAssetUnits(assetId, itemId, [{
    relPath: "pkg.unitypackage", format: "unitypackage", kind: "unitypackage", name: "pkg", size: 8, fingerprint: fp,
    policy: importable ? "single_unitypackage" : "unknown_structure", importable, parseState: "ok",
    avatars: [], evidence: {},
  }]);
  return { itemId, assetId, unitId: ids.get("pkg.unitypackage")! };
}

describe("POST /api/import-plans 分组", () => {
  test("单 item：保持 {plan,items,precheck} 原契约", async () => {
    const u = unitOf("single");
    const res = await app().inject({ method: "POST", url: "/api/import-plans", payload: { unitIds: [u.unitId], projectPath: dir } });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.ok(body.plan);
    assert.ok(Array.isArray(body.items));
    assert.equal(body.items.length, 1);
    assert.equal(body.plans, undefined, "单 item 不使用分组响应");
  });

  test("跨 item：每个 item 一个计划，返回 {plans:[...]}", async () => {
    const a = unitOf("item-a"); const b = unitOf("item-b");
    const res = await app().inject({ method: "POST", url: "/api/import-plans", payload: { unitIds: [a.unitId, b.unitId], projectPath: dir } });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.plans));
    assert.equal(body.plans.length, 2);
    const itemIds = body.plans.map((p: any) => p.itemId).sort();
    assert.deepEqual(itemIds, [a.itemId, b.itemId].sort());
    for (const p of body.plans) {
      assert.ok(p.plan && Array.isArray(p.items));
      assert.equal(p.plan.item_id, p.itemId);
      assert.ok(p.items.every((it: any) => Number(it.asset_id) === (p.itemId === a.itemId ? a.assetId : b.assetId)));
    }
  });

  test("组内失败隔离：一个 item 的单元不可导入，其它组仍建计划", async () => {
    const good = unitOf("good"); const bad = unitOf("bad", false);
    const res = await app().inject({ method: "POST", url: "/api/import-plans", payload: { unitIds: [good.unitId, bad.unitId], projectPath: dir } });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.plans.length, 2);
    const ok = body.plans.find((p: any) => p.itemId === good.itemId);
    const failed = body.plans.find((p: any) => p.itemId === bad.itemId);
    assert.ok(ok?.plan, "成功的组必须返回计划");
    assert.ok(failed?.error, "失败的组返回 error");
    assert.equal(failed.error.code, "INVALID_INPUT");
    const badPlans = (t.db.prepare("SELECT COUNT(*) c FROM import_plans WHERE item_id=?").get(bad.itemId) as any).c;
    assert.equal(badPlans, 0, "失败组不得留下半成品计划");
  });
});
