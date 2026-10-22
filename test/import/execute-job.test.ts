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
import { analyzeItemStructure, cancelImportRun, canTransitionRunItem, createImportPlan, executeImportPlan, getPlanView, precheckImportPlan } from "../../apps/server/src/services/structure";
import { runJob, type JobDeps } from "../../apps/server/src/jobs/runner";

let t: TempDb; let repo: Repo; let itemId: number; let rootId: number; let dir: string; let project: string;
beforeEach(() => {
  t = openTempDb(); repo = new Repo(t.db); rootId = addRoot(t.db, "/lib"); itemId = addItem(t.db, { title: "job import" });
  dir = mkdtempSync(join(tmpdir(), "av-execjob-"));
  project = join(dir, "UnityProject"); mkdirSync(join(project, "Assets"), { recursive: true });
});
afterEach(() => { t.close(); rmSync(dir, { recursive: true, force: true }); });

const GUID_HEX = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
async function readyPlan(guid = GUID_HEX, pkgName = "pkg.unitypackage") {
  const pkg = join(dir, pkgName); writeFileSync(pkg, Buffer.alloc(12, 1));
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
    writeFileSync(join(project, "Assets", "Thing.meta"), "fileFormatVersion: 2\nguid: " + GUID_HEX + "\n");
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
    writeFileSync(join(project, "Assets", "Thing.meta"), "fileFormatVersion: 2\nguid: " + GUID_HEX + "\n");
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
    assert.equal(detail.missing, 0, "GUID 验证必须无缺失");
    assert.ok(detail.found >= 1);
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

  test("task-51：≤500 GUID 全量验证 → verified/all/checked=expected", async () => {
    const { plan } = await readyPlan();
    writeFileSync(join(project, "Assets", "Thing.meta"), "fileFormatVersion: 2\nguid: " + GUID_HEX + "\n");
    const res = await executeImportPlan({ repo, unity: fakeUnity() as any, stagingDir: join(dir, "stage"), waitMs: 0 }, plan.id);
    assert.equal(res.run.status, "verified");
    assert.equal(res.run.verification_scope, "all");
    assert.equal(res.run.checked_count, 1);
    assert.equal(res.run.expected_count, 1);
    const detail = JSON.parse(res.items[0].detail_json);
    assert.equal(detail.missing, 0);
    assert.equal(detail.checked, 1);
    assert.equal(detail.expected, 1);
  });

  test("task-51：>500 GUID 抽样 500 → verification_scope=sampled", async () => {
    const { plan } = await readyPlan();
    const assets = Array.from({ length: 600 }, (_, i) => ({ guid: String(i).padStart(8, "0") + "0".repeat(24), assetPath: "Assets/F" + i + ".fbx", type: "Model", size: 1, hasPreview: false }));
    const first = repo.listAssets(plan.item_id)[0];
    repo.replaceUnityPackageAssets(first.id, assets);
    for (let i = 0; i < 600; i++) writeFileSync(join(project, "Assets", "F" + i + ".meta"), "guid: " + assets[i].guid + "\n");
    const res = await executeImportPlan({ repo, unity: fakeUnity() as any, stagingDir: join(dir, "stage"), waitMs: 0 }, plan.id);
    assert.equal(res.run.status, "verified");
    assert.equal(res.run.verification_scope, "sampled");
    assert.equal(res.run.checked_count, 500);
    assert.equal(res.run.expected_count, 600);
    const detail = JSON.parse(res.items[0].detail_json);
    assert.equal(detail.verificationScope, "sampled");
    assert.equal(detail.missing, 0);
  });

  test("task-51：缺 GUID → partial_success；工程不可读 → unknown", async () => {
    const { plan } = await readyPlan();
    // 3 个期望只落 2 个
    const a = repo.listAssets(plan.item_id)[0];
    repo.replaceUnityPackageAssets(a.id, [
      { guid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", assetPath: "Assets/A.fbx", type: "Model", size: 1, hasPreview: false },
      { guid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", assetPath: "Assets/B.fbx", type: "Model", size: 1, hasPreview: false },
      { guid: "cccccccccccccccccccccccccccccccc", assetPath: "Assets/C.fbx", type: "Model", size: 1, hasPreview: false },
    ]);
    writeFileSync(join(project, "Assets", "A.meta"), "guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
    writeFileSync(join(project, "Assets", "B.meta"), "guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n");
    const res = await executeImportPlan({ repo, unity: fakeUnity() as any, stagingDir: join(dir, "stage"), waitMs: 0 }, plan.id);
    assert.equal(res.run.status, "partial_success");
    assert.equal(res.items[0].status, "partial_success");
    assert.equal(JSON.parse(res.items[0].detail_json).missing, 1);

    const { plan: p2 } = await readyPlan(GUID_HEX, "pkg2.unitypackage");
    rmSync(join(project, "Assets"), { recursive: true, force: true });
    const res2 = await executeImportPlan({ repo, unity: fakeUnity() as any, stagingDir: join(dir, "stage2"), waitMs: 0 }, p2.id);
    assert.equal(res2.run.status, "unknown");
    assert.equal(res2.items[0].status, "unknown");
    assert.equal(JSON.parse(res2.items[0].detail_json).possible_side_effect, true);
  });
  test("task-51：命令已发后 Unity 断线 → unknown（possible_side_effect），不自动重试", async () => {
    const { plan } = await readyPlan();
    const unity: any = fakeUnity();
    unity.call = async (name: string, args: any) => {
      if (name === "read_console" && args?.action === "clear") return { isError: false, text: "", structured: { data: [] } };
      throw Object.assign(new Error("session lost"), { code: "UPSTREAM_ERROR" });
    };
    const res = await executeImportPlan({ repo, unity, stagingDir: join(dir, "stage"), waitMs: 0 }, plan.id);
    assert.equal(res.run.status, "unknown");
    assert.equal(res.items[0].status, "unknown");
    const detail = JSON.parse(res.items[0].detail_json);
    assert.equal(detail.possible_side_effect, true);
    assert.equal(repo.getImportPlan(plan.id).status, "unknown");
    assert.throws(() => precheckImportPlan(repo, plan.id), /不可执行/, "unknown 计划不得自动重试");
    assert.equal(canTransitionRunItem("unknown", "importing"), false, "unknown 是终态");
  });

  test("task-51：取消执行 → run/item cancelled 且记录 possible_side_effect", async () => {
    const { plan } = await readyPlan();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const unity: any = fakeUnity();
    const baseCsharp = unity.csharp;
    unity.csharp = async (code: string) => {
      if (code.includes("AssetDatabase.ImportPackage")) { await gate; return "QUEUED|fake|1"; }
      return baseCsharp(code);
    };
    const exec = executeImportPlan({ repo, unity, stagingDir: join(dir, "stage"), waitMs: 0 }, plan.id);
    const deadline = Date.now() + 3000;
    let run: any = null;
    while (Date.now() < deadline) {
      run = repo.latestImportRun(plan.id);
      if (run && String(run.status) === "running" && repo.listImportRunItems(run.id).some((i: any) => i.status === "importing")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(run, "必须进入 importing 阶段");
    const cancelled = cancelImportRun(repo, run.id);
    assert.equal(cancelled.run.status, "cancelled");
    release();
    const res = await exec;
    assert.equal(res.run.status, "cancelled");
    const item = res.items[0];
    assert.equal(item.status, "cancelled");
    const detail = JSON.parse(item.detail_json);
    assert.equal(detail.possible_side_effect, true, "已进入 importing 的取消必须标记可能副作用");
    assert.equal(repo.getImportPlan(plan.id).status, "cancelled");
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
