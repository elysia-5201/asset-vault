/**
 * task-47：工作台头像全量 + 一键批量结构扫描（scan-all）。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { openTempDb, addItem, addRoot, addAsset, addAvatar, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerRoutes } from "../../apps/server/src/http/routes";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";
import { runJob, type JobDeps } from "../../apps/server/src/jobs/runner";

const FIX = fileURLToPath(new URL("../fixtures/structure/out/", import.meta.url));
let t: TempDb; let repo: Repo; let rootId: number; let dir: string;
beforeEach(() => {
  t = openTempDb(); repo = new Repo(t.db); rootId = addRoot(t.db, "/lib");
  dir = mkdtempSync(join(tmpdir(), "av-scanall-"));
});
afterEach(() => { t.close(); rmSync(dir, { recursive: true, force: true }); });

const addArchiveItem = (title: string) => {
  const itemId = addItem(t.db, { title });
  const a = addAsset(t.db, itemId, rootId, join(dir, title + ".zip"), { kind: "archive", container: "zip", path: join(dir, title + ".zip"), path_norm: join(dir, title + ".zip"), size: 10 });
  return { itemId, assetId: a };
};
const routeApp = () => {
  const app = Fastify({ logger: false });
  registerRoutes(app as any, {
    repo, media: {} as any, booth: {} as any, runner: {} as any, log: () => {}, version: "test",
    dbPath: join(dir, "t.db"), dataDir: dir, pipeline: null, limits: resolveLimits({}),
  } as any);
  return app;
};

describe("workbenchAvatarCounts", () => {
  test("没有单元时也返回全表 avatar（计数 0），有证据后叠加", () => {
    const a = addAvatar(t.db, "Manuka"); const b = addAvatar(t.db, "Kikyo");
    let rows = repo.workbenchAvatarCounts();
    assert.equal(rows.length, 2, "avatars 全表都要出现");
    assert.ok(rows.every((r) => r.counts.confirmed === 0 && r.counts.probable === 0));
    const { itemId, assetId } = addArchiveItem("x");
    repo.replaceAssetUnits(assetId, itemId, [{
      relPath: "a.unitypackage", format: "unitypackage", kind: "unitypackage", name: "a", size: 1, fingerprint: "1:2:3",
      policy: "single_unitypackage", importable: true, parseState: "ok", avatars: [{ avatarId: a, via: "package_path", level: "probable", hits: ["Assets/Manuka/x.fbx"] }], evidence: {},
    }]);
    rows = repo.workbenchAvatarCounts();
    const manuka = rows.find((r) => r.avatar.id === a)!;
    assert.equal(manuka.counts.probable, 1);
    assert.equal(rows.find((r) => r.avatar.id === b)!.counts.probable, 0, "没证据的 avatar 计数仍为 0");
  });
});

describe("scan-all 目标选择", () => {
  test("onlyMissing 排除已分析出单元的 item；无归档资产的 item 不进目标", () => {
    const a = addArchiveItem("has archive").itemId;
    const b = addItem(t.db, { title: "no archive" });
    assert.deepEqual(repo.listStructureScanTargets(false), [a]);
    assert.deepEqual(repo.listStructureScanTargets(true), [a]);
    const asset = repo.listAssets(a)[0];
    repo.replaceAssetUnits(asset.id, a, [{ relPath: "u", format: "unitypackage", kind: "unitypackage", name: "u", size: 1, fingerprint: "x", policy: "single_unitypackage", importable: true, parseState: "ok", avatars: [], evidence: {} }]);
    assert.deepEqual(repo.listStructureScanTargets(true), [], "onlyMissing 跳过已有单元的条目");
    assert.ok(repo.listStructureScanTargets(false).includes(a));
    void b;
  });
});

describe("POST /api/workbench/scan-all", () => {
  test("202 + job(payload.all)；重复请求 409", async () => {
    addArchiveItem("one");
    const app = routeApp();
    const r1 = await app.inject({ method: "POST", url: "/api/workbench/scan-all", payload: { onlyMissing: true } });
    assert.equal(r1.statusCode, 202);
    const body = JSON.parse(r1.body);
    assert.ok(body.jobId > 0);
    assert.equal(body.onlyMissing, true);
    const job = repo.getJob(body.jobId)!;
    assert.equal(job.kind, "structure");
    assert.equal(job.item_id, null);
    const payload = JSON.parse(job.payload!);
    assert.equal(payload.all, true);
    assert.equal(payload.onlyMissing, true);
    const r2 = await app.inject({ method: "POST", url: "/api/workbench/scan-all", payload: {} });
    assert.equal(r2.statusCode, 409);
    assert.equal(JSON.parse(r2.body).error.code, "CONFLICT");
  });
});

describe("runner scan-all", () => {
  test("遍历目标、写 progress 事件、单项失败不中断", async () => {
    const pkg = join(FIX, "B_mixed.unitypackage");
    const item1 = addItem(t.db, { title: "ok item" });
    addAsset(t.db, item1, rootId, pkg, { kind: "unitypackage", container: "unitypackage", path: pkg, path_norm: pkg, size: 1 });
    const item2 = addItem(t.db, { title: "bad item" });
    const job = repo.createJob("structure", null, { all: true, onlyMissing: false }, 15);
    // 目标里混入一个不存在的 item → analyze 抛 NOT_FOUND，应在单项层被吞掉
    (repo as any).listStructureScanTargets = () => [item1, 999999];
    const deps: JobDeps = { repo, media: {} as any, booth: {} as any, log: () => {}, limits: resolveLimits({}) };
    await runJob(deps, job.id);
    assert.equal(repo.getJob(job.id)!.state, "done");
    assert.ok(repo.listUnits({ itemId: item1 }).length > 0, "成功条目必须产出单元");
    const events = (t.db.prepare("SELECT event, detail FROM job_events WHERE job_id=? ORDER BY id").all(job.id) as any[]);
    const progress = events.filter((e) => e.event === "structure_progress");
    assert.equal(progress.length, 2, "每个目标一条进度事件");
    const final = events.find((e) => e.event === "structure_analyzed");
    assert.ok(final);
    const detail = JSON.parse(final.detail);
    assert.equal(detail.done, 1);
    assert.equal(detail.failed, 1);
    assert.equal(detail.truncated, false);
    void item2;
  });
});
