/** task-51：导入风险扫描（建计划写入 / 确认 / 执行前重扫不一致阻断）。 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { openTempDb, addItem, addRoot, addAsset, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerRoutes } from "../../apps/server/src/http/routes";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";
import { executeImportPlan, precheckImportPlanWithRisk } from "../../apps/server/src/services/structure";

const FIX = fileURLToPath(new URL("../fixtures/structure/out/", import.meta.url));
let t: TempDb; let repo: Repo; let rootId: number; let dir: string;
beforeEach(() => {
  t = openTempDb(); repo = new Repo(t.db); rootId = addRoot(t.db, "/lib"); dir = mkdtempSync(join(tmpdir(), "av-risk-"));
});
afterEach(() => { t.close(); rmSync(dir, { recursive: true, force: true }); });
const app = () => {
  const a = Fastify({ logger: false });
  registerRoutes(a as any, { repo, media: {} as any, booth: {} as any, runner: {} as any, log: () => {}, version: "test", dbPath: join(dir, "t.db"), dataDir: dir, pipeline: null, limits: resolveLimits({}) } as any);
  return a;
};
function planWith(paths: string[]) {
  const itemId = addItem(t.db, { title: "risk" });
  const pkg = join(FIX, "B_mixed.unitypackage");
  const assetId = addAsset(t.db, itemId, rootId, pkg, { kind: "unitypackage", container: "unitypackage", path: pkg, path_norm: pkg, size: 1, mtime: "2026-10-02T00:00:00.000Z" });
  repo.replaceUnityPackageAssets(assetId, paths.map((p, i) => ({ guid: "g" + i, assetPath: p, type: "Text", size: 1, hasPreview: false })));
  t.db.prepare("UPDATE assets SET index_state='done' WHERE id=?").run(assetId);
  const ids = repo.replaceAssetUnits(assetId, itemId, [{ relPath: "pkg.unitypackage", format: "unitypackage", kind: "unitypackage", name: "pkg", size: 1, fingerprint: "1:2026-10-02T00:00:00.000Z:", policy: "single_unitypackage", importable: true, parseState: "ok", avatars: [], evidence: {} }]);
  return { itemId, assetId, unitId: ids.get("pkg.unitypackage")!, path: pkg };
}

describe("plan risk", () => {
  test("包内 .cs → warning，建计划即 needs_confirmation 并暴露 risks", async () => {
    const p = planWith(["Assets/Scripts/Bad.cs", "Assets/Manuka/x.fbx"]);
    const res = await app().inject({ method: "POST", url: "/api/import-plans", payload: { unitIds: [p.unitId], projectPath: dir } });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.plan.status, "needs_confirmation");
    assert.equal(body.risk_state, "warning");
    assert.ok(body.risks.hits.some((h: any) => h.type === "code" && /Bad\.cs$/.test(h.path)));
    const got = await app().inject({ method: "GET", url: "/api/import-plans/" + body.plan.id });
    const view = JSON.parse(got.body);
    assert.equal(view.risk_state, "warning");
    assert.ok(view.risks);
  });

  test("task-51：warning/unknown 未 ack → RISK_REQUIRES_ACK；riskAck 后 ready 并记录 ack 摘要", async () => {
    const p = planWith(["Assets/Scripts/Bad.cs"]);
    const res = await app().inject({ method: "POST", url: "/api/import-plans", payload: { unitIds: [p.unitId], projectPath: dir } });
    const body = JSON.parse(res.body);
    const planId = body.plan.id;
    assert.equal(body.risk_state, "warning");
    const c1 = await app().inject({ method: "POST", url: "/api/import-plans/" + planId + "/confirm", payload: {} });
    assert.equal(c1.statusCode, 409);
    assert.equal(JSON.parse(c1.body).error.code, "RISK_REQUIRES_ACK");
    assert.equal(repo.getImportPlan(planId).status, "needs_confirmation");
    const c2 = await app().inject({ method: "POST", url: "/api/import-plans/" + planId + "/confirm", payload: { riskAck: true } });
    assert.equal(c2.statusCode, 200);
    const view = JSON.parse(c2.body);
    assert.equal(view.plan.status, "ready");
    assert.equal(view.plan.user_confirmed, 1);
    assert.ok(view.risks.risk_ack_at, "risk_ack_at 必须记录");
    assert.equal(view.risks.risk_ack_digest, view.risks.digest);
  });

  test("task-51：risk_state=blocked 即使 riskAck 也拒绝（RISK_BLOCKED）", async () => {
    const p = planWith(["Assets/Manuka/x.fbx"]);
    const res = await app().inject({ method: "POST", url: "/api/import-plans", payload: { unitIds: [p.unitId], projectPath: dir } });
    const planId = JSON.parse(res.body).plan.id;
    t.db.prepare("UPDATE import_plans SET risk_state='blocked', status='blocked' WHERE id=?").run(planId);
    const c = await app().inject({ method: "POST", url: "/api/import-plans/" + planId + "/confirm", payload: { riskAck: true } });
    assert.equal(c.statusCode, 409);
    assert.equal(JSON.parse(c.body).error.code, "RISK_BLOCKED");
  });

  test("task-56：伪装文件（.png 实为 MZ）→ disguised warning", async () => {
    const itemId = addItem(t.db, { title: "magic" });
    const p = join(dir, "evil.png");
    writeFileSync(p, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64, 0)]));
    const assetId = addAsset(t.db, itemId, rootId, p, { kind: "unitypackage", container: "unitypackage", path: p, path_norm: p, size: 66, mtime: "2026-10-02T00:00:00.000Z" });
    repo.replaceUnityPackageAssets(assetId, [{ guid: "g1", assetPath: "Assets/Manuka/x.fbx", type: "Model", size: 1, hasPreview: false }]);
    t.db.prepare("UPDATE assets SET index_state='done' WHERE id=?").run(assetId);
    const ids = repo.replaceAssetUnits(assetId, itemId, [{ relPath: "evil.png", format: "unitypackage", kind: "unitypackage", name: "evil", size: 66, fingerprint: "66:2026-10-02T00:00:00.000Z:", policy: "single_unitypackage", importable: true, parseState: "ok", avatars: [], evidence: {} }]);
    const res = await app().inject({ method: "POST", url: "/api/import-plans", payload: { unitIds: [ids.get("evil.png")], projectPath: dir } });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.risk_state, "warning");
    assert.ok(body.risks.hits.some((h: any) => h.type === "disguised" && /evil\.png$/.test(h.path)), JSON.stringify(body.risks.hits));
  });

  test("确认后执行前风险摘要变化 → 重扫 blocked（RISK_CHANGED），不执行 Unity", async () => {
    const p = planWith(["Assets/Manuka/x.fbx"]);
    const res = await app().inject({ method: "POST", url: "/api/import-plans", payload: { unitIds: [p.unitId], projectPath: dir } });
    const body = JSON.parse(res.body);
    assert.equal(body.risk_state, "clear");
    const planId = body.plan.id;
    t.db.prepare("UPDATE import_plans SET user_confirmed=1, status='ready' WHERE id=?").run(planId);
    // 计划快照生成后包内新增 .cs
    repo.replaceUnityPackageAssets(p.assetId, [{ guid: "g1", assetPath: "Assets/Manuka/x.fbx", type: "Model", size: 1, hasPreview: false }, { guid: "g2", assetPath: "Assets/Scripts/Evil.cs", type: "Text", size: 1, hasPreview: false }]);
    await assert.rejects(() => exec(planId), /风险扫描/);
    const plan = repo.getImportPlan(planId)!;
    assert.equal(plan.status, "blocked");
    assert.equal(plan.risk_state, "warning");
    const run = repo.latestImportRun(planId)!;
    assert.equal(run.status, "failed", "风险阻断也留失败审计（task-46）");
    const unit = repo.listImportRunItems(run.id)[0];
    assert.match(String(unit.error), /^RISK_CHANGED: /);
  });
});
async function exec(planId: number) {
  return executeImportPlan({ repo, unity: {} as any, stagingDir: join(dir, "stage"), waitMs: 0 }, planId);
}
