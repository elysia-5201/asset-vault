/** task-51：staging 台账/清理 API/启动 sweep。 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { openTempDb, addItem, addRoot, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerRoutes } from "../../apps/server/src/http/routes";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";
import { adoptLegacyStaging, sweepStaging, sweepStagingOnStartup } from "../../apps/server/src/services/structure";

let t: TempDb; let repo: Repo; let rootId: number; let dir: string; let stagingDir: string;
beforeEach(() => {
  t = openTempDb(); repo = new Repo(t.db); rootId = addRoot(t.db, "/lib");
  dir = mkdtempSync(join(tmpdir(), "av-staging-")); stagingDir = join(dir, "unity-staging"); mkdirSync(stagingDir, { recursive: true });
});
afterEach(() => { t.close(); rmSync(dir, { recursive: true, force: true }); });
const old = "2020-01-01T00:00:00.000Z";
function staged(name: string, size = 4): string {
  const p = join(stagingDir, name); writeFileSync(p, Buffer.alloc(size, 1));
  const row = repo.registerStagingFile({ path: p, size, state: "stale" });
  t.db.prepare("UPDATE staging_files SET last_used_at=? WHERE id=?").run(old, row.id);
  return p;
}
const app = () => {
  const a = Fastify({ logger: false });
  registerRoutes(a as any, { repo, media: {} as any, booth: {} as any, runner: {} as any, log: () => {}, version: "test", dbPath: join(dir, "t.db"), dataDir: dir, pipeline: null, limits: resolveLimits({}) } as any);
  return a;
};

describe("staging sweep", () => {
  test("dryRun 只报告；实际清理删除文件+登记行", () => {
    const p = staged("a.unitypackage");
    const dry = sweepStaging(repo, stagingDir, { olderThanDays: 7, dryRun: true });
    assert.equal(dry.candidates, 1);
    assert.equal(dry.removed, 0);
    assert.ok(existsSync(p) && repo.listStagingFiles().length === 1);
    const real = sweepStaging(repo, stagingDir, { olderThanDays: 7 });
    assert.equal(real.removed, 1);
    assert.equal(existsSync(p), false);
    assert.equal(repo.listStagingFiles().length, 0);
  });

  test("越界路径/符号链接拒绝清理（只删登记行且不越界）", () => {
    const outside = join(dir, "outside.bin"); writeFileSync(outside, "x");
    const row = repo.registerStagingFile({ path: outside, size: 1, state: "stale" });
    t.db.prepare("UPDATE staging_files SET last_used_at=? WHERE id=?").run(old, row.id);
    const res = sweepStaging(repo, stagingDir, { olderThanDays: 7 });
    assert.equal(res.removed, 0);
    assert.ok(res.errors.some((e) => /越界/.test(e)));
    assert.ok(existsSync(outside), "越界文件不得删除");

    const target = join(dir, "target.bin"); writeFileSync(target, "x");
    const link = join(stagingDir, "link.unitypackage"); symlinkSync(target, link);
    const lrow = repo.registerStagingFile({ path: link, size: 1, state: "stale" });
    t.db.prepare("UPDATE staging_files SET last_used_at=? WHERE id=?").run(old, lrow.id);
    const res2 = sweepStaging(repo, stagingDir, { olderThanDays: 7 });
    assert.equal(res2.removed, 0);
    assert.ok(res2.errors.some((e) => /符号链接/.test(e)));
    assert.ok(existsSync(target), "符号链接目标不得删除");
  });

  test("启动 sweep 只清 >7 天，活跃 run 保留", () => {
    const oldFile = staged("old.unitypackage");
    const recent = join(stagingDir, "recent.unitypackage"); writeFileSync(recent, "x");
    const rrow = repo.registerStagingFile({ path: recent, size: 1, state: "stale" });
    t.db.prepare("UPDATE staging_files SET last_used_at=? WHERE id=?").run(new Date().toISOString(), rrow.id);
    // 活跃 run 引用
    const itemId = addItem(t.db, { title: "active" });
    const plan = t.db.prepare("INSERT INTO import_plans(item_id,project_path,status,created_at) VALUES (?,?,'running',?)").run(itemId, dir, new Date().toISOString());
    const run = repo.createImportRun({ planId: Number(plan.lastInsertRowid), projectPath: dir });
    const activeFile = join(stagingDir, "active.unitypackage"); writeFileSync(activeFile, "x");
    const arow = repo.registerStagingFile({ path: activeFile, size: 1, runId: run.id, state: "stale" });
    t.db.prepare("UPDATE staging_files SET last_used_at=? WHERE id=?").run(old, arow.id);
    const res = sweepStagingOnStartup(repo, stagingDir);
    assert.equal(existsSync(oldFile), false);
    assert.ok(res.skipped >= 1, "活跃 run 的 staging 不清理");
    assert.ok(existsSync(activeFile));
    assert.ok(existsSync(recent), "未过期文件保留");
  });


  test("启动收养历史 staging：递归普通文件→stale；拒符号链接；dry-run 命中、cleanup 只删过期 stale", async () => {
    const sub = join(stagingDir, "a", "b"); mkdirSync(sub, { recursive: true });
    const oldTime = new Date("2020-01-01T00:00:00.000Z");
    const oldFile = join(sub, "old.unitypackage"); writeFileSync(oldFile, Buffer.alloc(8, 1)); utimesSync(oldFile, oldTime, oldTime);
    const recent = join(stagingDir, "recent.unitypackage"); writeFileSync(recent, Buffer.alloc(4, 1));
    const target = join(dir, "outside-target.bin"); writeFileSync(target, "x");
    const link = join(stagingDir, "legacy-link.unitypackage"); symlinkSync(target, link);
    const registered = staged("registered.unitypackage");
    const res = adoptLegacyStaging(repo, stagingDir);
    assert.equal(res.adopted, 2, "old + recent 被收养；已登记/符号链接跳过");
    assert.ok(res.errors.some((e) => /符号链接/.test(e)));
    const rows = repo.listStagingFiles({ state: "stale" });
    assert.equal(rows.length, 3, "adopted 2 + 原 stale 1");
    assert.ok(rows.every((r) => r.state === "stale"));
    const adoptedRow = repo.getStagingFileByPath(oldFile)!;
    assert.ok(adoptedRow.last_used_at.startsWith("2020-01-01"), "last_used_at 用文件 mtime");

    const dry = sweepStaging(repo, stagingDir, { olderThanDays: 7, dryRun: true });
    assert.equal(dry.candidates, 2, "两条 2020 文件命中；recent 未过期");
    assert.ok(existsSync(oldFile));
    const real = sweepStaging(repo, stagingDir, { olderThanDays: 7 });
    assert.equal(real.removed, 2);
    assert.equal(existsSync(oldFile), false);
    assert.ok(existsSync(recent), "未过期 stale 保留");
    assert.ok(existsSync(target), "符号链接目标不得删除");
    assert.equal(existsSync(registered), false, "已登记且过期的 stale 同样清理");
  });
  test("API：GET /api/staging + POST cleanup dryRun", async () => {
    staged("api.unitypackage");
    const a = app();
    const list = await a.inject({ method: "GET", url: "/api/staging" });
    assert.equal(list.statusCode, 200);
    assert.equal(JSON.parse(list.body).files.length, 1);
    const dry = await a.inject({ method: "POST", url: "/api/staging/cleanup", payload: { dryRun: true, olderThanDays: 7 } });
    assert.equal(dry.statusCode, 200);
    assert.equal(JSON.parse(dry.body).candidates, 1);
    assert.equal(JSON.parse(dry.body).removed, 0);
    assert.equal(repo.listStagingFiles().length, 1);
  });
});
