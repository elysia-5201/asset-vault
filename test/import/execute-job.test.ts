/**
 * task-42：导入执行走 Job（202 {jobId,planId} / 重复 409 / 失败不自动重试 / 成功写 run）。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { openTempDb, addItem, addRoot, addAsset, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerRoutes } from "../../apps/server/src/http/routes";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";
import { analyzeItemStructure, createImportPlan, executeImportPlan, getPlanView, precheckImportPlan } from "../../apps/server/src/services/structure";
import { runJob, type JobDeps } from "../../apps/server/src/jobs/runner";

let t: TempDb; let repo: Repo; let itemId: number; let rootId: number; let dir: string; let project: string;
beforeEach(() => {
  t = openTempDb(); repo = new Repo(t.db); rootId = addRoot(t.db, "/lib"); itemId = addItem(t.db, { title: "job import" });
  dir = mkdtempSync(join(tmpdir(), "av-execjob-"));
  project = join(dir, "UnityProject"); mkdirSync(join(project, "Assets"), { recursive: true });
});
afterEach(() => { t.close(); rmSync(dir, { recursive: true, force: true }); });

async function readyPlan(guid = "guid-abc") {
  const pkg = join(dir, "pkg.unitypackage"); writeFileSync(pkg, Buffer.alloc(12, 1));
  const a = addAsset(t.db, itemId, rootId, pkg, { kind: "unitypackage", container: "unitypackage", path: pkg, path_norm: pkg, size: 12, mtime: "2026-10-02T00:00:00.000Z", sha256: "abcdef0123456789" });
  repo.replaceUnityPackageAssets(a, [{ guid, assetPath: "Assets/Thing.fbx", type: "Model", size: 1, hasPreview: false }]);
  t.db.prepare("UPDATE assets SET index_state='done' WHERE id=?").run(a);
  await analyzeItemStructure(repo, itemId);
  const unit = repo.listUnits({ itemId }).find((u) => Number(u.asset_id) === a && u.importable)!;
  const view = createImportPlan(repo, { unitIds: [Number(unit.id)], projectPath: project });
  assert.equal(view.plan.status, "ready");
  return { plan: view.plan, unit };
}
const fakeUnity = (opts: { fail?: boolean } = {}) => ({
  endpoint: "fake", serverName: "fake",
  async csharp(code: string) {
    if (opts.fail) throw Object.assign(new Error("connect refused"), { code: "UPSTREAM_ERROR" });
    if (code.includes("Application.dataPath")) return project + "/Assets|" + project + "|2022.3|0|0|";
    if (code.includes("AssetDatabase.ImportPackage")) return "QUEUED|fake|1";
    return "";
  },
  async call() { return { isError: false, text: "", structured: { data: [] } }; },
});
const deps = (unity: any): JobDeps => ({ repo, media: {} as any, booth: {} as any, log: () => {}, unity: unity as any, dataDir: dir, limits: resolveLimits({}) });
const routeApp = () => {
  const app = Fastify({ logger: false });
  registerRoutes(app as any, {
    repo, media: {} as any, booth: {} as any, runner: {} as any, log: () => {}, version: "test",
    dbPath: join(dir, "t.db"), dataDir: dir, pipeline: null, limits: resolveLimits({}),
  } as any);
  return app;
};

describe("execute → job", () => {
  test("POST execute 返回 202 {jobId,planId}，job payload=planId；重复 execute 409", async () => {
    const { plan } = await readyPlan();
    const app = routeApp();
    const r1 = await app.inject({ method: "POST", url: "/api/import-plans/" + plan.id + "/execute" });
    assert.equal(r1.statusCode, 202);
    const body = JSON.parse(r1.body);
    assert.equal(body.planId, plan.id);
    assert.ok(body.jobId > 0);
    const job = repo.getJob(body.jobId)!;
    assert.equal(job.kind, "import");
    assert.equal(job.item_id, plan.item_id);
    assert.equal(JSON.parse(job.payload!).planId, plan.id);
    assert.equal(job.state, "queued");
    const r2 = await app.inject({ method: "POST", url: "/api/import-plans/" + plan.id + "/execute" });
    assert.equal(r2.statusCode, 409);
    assert.equal(JSON.parse(r2.body).error.code, "CONFLICT");
    assert.equal(repo.getImportPlan(plan.id).status, "ready", "路由不产生副作用（只建 job）");
    const gp = await app.inject({ method: "GET", url: "/api/import-plans/" + plan.id });
    const pv = JSON.parse(gp.body);
    assert.equal(pv.run_id, null, "未执行时 run_id=null");
    assert.equal(pv.latestRun, null);
  });

  test("执行中：plan.status=running，PlanView.run_id 指向当前 run", async () => {
    const { plan } = await readyPlan();
    writeFileSync(join(project, "Assets", "Thing.meta"), "fileFormatVersion: 2\nguid: guid-abc\n");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const unity: any = fakeUnity();
    unity.csharp = async (code: string) => {
      if (code.includes("Application.dataPath")) return project + "/Assets|" + project + "|2022.3|0|0|";
      if (code.includes("AssetDatabase.ImportPackage")) { await gate; return "QUEUED|fake|1"; }
      return "";
    };
    const exec = executeImportPlan({ repo, unity, stagingDir: join(dir, "stage"), waitMs: 0 }, plan.id);
    const deadline = Date.now() + 3000;
    let view: any = null;
    while (Date.now() < deadline) {
      view = getPlanView(repo, plan.id);
      if (view && view.run_id && view.plan.status === "running") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(view && view.run_id, "执行中必须能拿到 run_id");
    assert.equal(view.plan.status, "running");
    assert.equal(view.latestRun.id, view.run_id);
    assert.equal(view.latestRun.status, "running");
    release();
    const result = await exec;
    assert.equal(result.run.status, "verified");
    assert.equal(repo.getImportPlan(plan.id).status, "executed");
  });

  test("runner 成功：run_items verified + plan executed（命令完成与验证分离）", async () => {
    const { plan } = await readyPlan();
    writeFileSync(join(project, "Assets", "Thing.meta"), "fileFormatVersion: 2\nguid: guid-abc\n");
    const job = repo.createJob("import", plan.item_id, { planId: plan.id }, 40);
    const claimed = repo.claimNextJob("test-holder", { leaseMs: 60_000 })!;
    assert.equal(claimed.id, job.id);
    await runJob(deps(fakeUnity()), job.id, { lease: { holder: "test-holder", token: claimed.lease_token } });
    const after = repo.getJob(job.id)!;
    assert.equal(after.state, "done");
    assert.equal(after.attempts, 1, "attempts=1，不允许自动重试");
    assert.equal(repo.getImportPlan(plan.id).status, "executed");
    assert.throws(() => precheckImportPlan(repo, plan.id), /不可执行/, "已执行计划不得再次执行（防重复外部导入）");
    const run = repo.latestImportRun(plan.id)!;
    assert.equal(run.status, "verified");
    const items = repo.listImportRunItems(run.id);
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "verified");
    const detail = JSON.parse(items[0].detail_json);
    assert.ok(detail.guidsMatched.length >= 1, "GUID 验证必须记录命中");
    const app = routeApp();
    const gp = await app.inject({ method: "GET", url: "/api/import-plans/" + plan.id });
    const pv = JSON.parse(gp.body);
    assert.equal(pv.run_id, run.id, "PlanView.run_id 指向最新 run");
    assert.equal(pv.latestRun.id, run.id);
    assert.equal(pv.latestRun.status, "verified");
    assert.equal(pv.plan.status, "executed");
  });

  test("runner 失败：job failed、plan failed，不自动创建重试作业", async () => {
    const { plan } = await readyPlan();
    const job = repo.createJob("import", plan.item_id, { planId: plan.id }, 40);
    await runJob(deps(fakeUnity({ fail: true })), job.id);
    assert.equal(repo.getJob(job.id)!.state, "failed");
    assert.equal(repo.getImportPlan(plan.id).status, "failed");
    const retries = (t.db.prepare("SELECT COUNT(*) c FROM jobs WHERE kind='import'").get() as any).c;
    assert.equal(retries, 1, "失败后不得自动生成新的 import 作业（外部副作用禁止自动重试）");
    // task-46：前置失败也必须留下 failed run + 逐项 run_item + 可读错误
    const run = repo.latestImportRun(plan.id);
    assert.ok(run, "Unity 离线也必须创建 failed run");
    assert.equal(run.status, "failed");
    const runItems = repo.listImportRunItems(run.id);
    assert.equal(runItems.length, 1, "每个 plan_item 都要有 failed run_item");
    assert.equal(runItems[0].status, "failed");
    assert.match(String(runItems[0].error), /^[A-Z_]+: .*connect refused|^UPSTREAM_ERROR:/);
    const view = getPlanView(repo, plan.id)!;
    assert.equal(view.run_id, run.id);
    assert.equal(view.lastError?.code, "UPSTREAM_ERROR");
    assert.match(String(view.lastError?.message), /connect refused/);
  });

  test("task-46：执行时指纹变化 → 仍记录 failed run/run_items 与 lastError", async () => {
    const { plan } = await readyPlan();
    t.db.prepare("UPDATE assets SET mtime='2026-10-09T00:00:00.000Z' WHERE id=?").run(Number(plan.item_id) ? (t.db.prepare("SELECT asset_id FROM import_plan_items WHERE plan_id=?").get(plan.id) as any).asset_id : 0);
    await assert.rejects(() => executeImportPlan({ repo, unity: fakeUnity() as any, stagingDir: join(dir, "stage"), waitMs: 0 }, plan.id), /指纹/);
    const run = repo.latestImportRun(plan.id);
    assert.ok(run, "指纹变化也要创建 failed run");
    assert.equal(run.status, "failed");
    const items = repo.listImportRunItems(run.id);
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "failed");
    assert.match(String(items[0].error), /^FINGERPRINT_CHANGED: /);
    const view = getPlanView(repo, plan.id)!;
    assert.equal(view.lastError?.code, "FINGERPRINT_CHANGED");
  });
});
