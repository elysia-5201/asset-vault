/**
 * AssetVault 核心冒烟（task36 Phase B / R1）
 *
 * 四项契约，全部走真实代码路径：
 *  1) 合成 ZIP（含 unitypackage）→ 真实 JobRunner 扫描作业（POST /api/scan + drain）→ indexAsset → Fastify inject 目录链
 *  2) 真实触发 maxEntryBytes 声明预算：目录 complete 与 contentReadLimited 分别断言
 *  3) 两次真实扫描：asset 主键 id 严格相同；同 basename/同字节独立目录仍为独立 item
 *  4) 真实 auto 命中 + auto 对照变化；item 级 manual 记录逐字段保留
 *
 * 隔离：openTempDb() 的 mkdtemp 库 + mkdtemp 媒体目录；API 全部 inject；不读真实素材、不连 7317。
 * 期望值全部写死（fixtures.expected），不由被测返回值生成。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { Repo } from "../../apps/server/src/db/repo";
import { MediaStore } from "../../apps/server/src/services/media";
import { registerRoutes } from "../../apps/server/src/http/routes";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";
import { JobRunner } from "../../apps/server/src/jobs/runner";
import { indexAsset } from "../../apps/server/src/services/indexing";
import { matchItem } from "../../apps/server/src/services/match";
import { sha256File } from "../../packages/core/src/hash";
import { normalizePath } from "../../packages/core/src/pathnorm";
import { openTempDb } from "../schema/_db";
import { makeSyntheticLibrary } from "./fixtures";

function openEnv() {
  const t = openTempDb();
  const repo = new Repo(t.db);
  const mediaDir = mkdtempSync(join(tmpdir(), "av-core-smoke-media-"));
  const media = new MediaStore(mediaDir);
  const limits = resolveLimits({});
  const runner = new JobRunner({ repo, media, booth: {} as any, log: () => {}, dataDir: mediaDir, limits });
  const app = Fastify({ logger: false });
  registerRoutes(app as any, {
    repo, media, booth: {} as any, runner, watcher: undefined,
    log: () => {}, version: "0.0.0-test", dbPath: t.file, dataDir: mediaDir,
    pipeline: null, limits,
  } as any);
  return {
    t, repo, media, app, runner,
    close: async () => { await app.close(); t.close(); rmSync(mediaDir, { recursive: true, force: true }); },
  };
}

/** 真实扫描入口：POST /api/scan 建作业 → JobRunner.drain 领取并执行（不复制 runner 建档分支）。 */
async function realScan(env: ReturnType<typeof openEnv>, root: string): Promise<number> {
  const res = await env.app.inject({ method: "POST", url: "/api/scan", payload: { path: root, deep: true } });
  assert.equal(res.statusCode, 200, "POST /api/scan: " + res.body);
  const jobId = Number(JSON.parse(res.body).jobId);
  assert.ok(jobId > 0, "必须返回 jobId");
  const n = await env.runner.drain(1);
  assert.equal(n, 1, "JobRunner 必须领取并执行扫描作业");
  const job = env.repo.getJob(jobId);
  assert.equal(job?.state, "done", "扫描作业必须 done: " + JSON.stringify(job));
  return jobId;
}

function assetIdOf(repo: Repo, p: string): number {
  const a = repo.getAssetByPathNorm(normalizePath(p));
  assert.ok(a, "资产未登记: " + p);
  return a.id;
}

function allAssetIds(env: ReturnType<typeof openEnv>): number[] {
  return (env.t.db.prepare("SELECT id FROM assets ORDER BY id").all() as any[]).map((r) => Number(r.id));
}

test("目标1：合成 ZIP 含 unitypackage → 真实扫描作业/索引/API 目录链", async () => {
  const lib = makeSyntheticLibrary();
  const env = openEnv();
  try {
    await realScan(env, lib.root);
    assert.equal(allAssetIds(env).length, lib.expected.scannedFiles, "真实扫描必须登记全部候选");

    const zipId = assetIdOf(env.repo, join(lib.root, "Shinano_Outfit", "Shinano_Outfit.zip"));
    const upkgId = assetIdOf(env.repo, join(lib.root, "Shinano_Outfit", "Shinano.unitypackage"));

    const ur = await indexAsset(env.repo, env.media, upkgId);
    assert.equal(ur.unityAssets, lib.expected.unityPackageGuids, "unitypackage GUID 数");

    const res = await env.app.inject({ method: "GET", url: "/api/assets/" + zipId + "/tree" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.completeness, "complete");
    assert.equal(body.contentReadLimited, false);
    const paths = body.entries.filter((e: any) => !e.isDir).map((e: any) => e.path).sort();
    assert.deepEqual(paths, lib.expected.zipEntryPaths, "API 目录条目必须等于事先写死的路径集合");
  } finally { await env.close(); lib.cleanup(); }
});

test("目标2：真实触发 maxEntryBytes 声明预算 → 目录 complete 且 contentReadLimited 分别成立", async () => {
  const lib = makeSyntheticLibrary();
  const env = openEnv();
  try {
    await realScan(env, lib.root);
    const id = assetIdOf(env.repo, join(lib.root, "Budget", "Budget.zip"));
    await indexAsset(env.repo, env.media, id, { limits: { maxEntryBytes: 8 } });

    const res = await env.app.inject({ method: "GET", url: "/api/assets/" + id + "/tree" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.completeness, "complete", "目录列举仍完整");
    assert.equal(body.contentReadLimited, true, "内容读取必须被真实预算限制");
    assert.ok(body.flags.some((f: any) => f.code === "BYTES"), "必须留下 BYTES 限制证据");
    const paths = body.entries.filter((e: any) => !e.isDir).map((e: any) => e.path).sort();
    assert.deepEqual(paths, lib.expected.budgetEntryPaths);
  } finally { await env.close(); lib.cleanup(); }
});

test("目标3：两次真实扫描 asset 主键严格相同；同 basename/同字节目录仍独立", async () => {
  const lib = makeSyntheticLibrary();
  const env = openEnv();
  try {
    await realScan(env, lib.root);
    const firstIds = allAssetIds(env);
    assert.equal(firstIds.length, lib.expected.scannedFiles, "首次扫描资产数");

    await realScan(env, lib.root);
    const secondIds = allAssetIds(env);
    assert.deepEqual(secondIds, firstIds, "第二次真实扫描后 asset 主键 id 必须严格相同");

    const items = Number((env.t.db.prepare("SELECT COUNT(*) c FROM items").get() as any).c);
    assert.equal(items, lib.expected.scannedFiles, "item 行数不增");

    const [d1, d2] = lib.expected.dupDirs;
    const a1 = assetIdOf(env.repo, join(d1, "Outfit.zip"));
    const a2 = assetIdOf(env.repo, join(d2, "Outfit.zip"));
    assert.notEqual(a1, a2, "同 basename/同字节的两个文件必须是两条 asset");
    assert.notEqual(env.repo.getAsset(a1)!.item_id, env.repo.getAsset(a2)!.item_id, "同 basename/同字节目录必须保持独立 item");
    assert.equal(await sha256File(join(d1, "Outfit.zip")), await sha256File(join(d2, "Outfit.zip")), "正例对照：两文件字节确实相同");
  } finally { await env.close(); lib.cleanup(); }
});

test("目标4：auto 命中且对照变化；manual 记录逐字段保留", async () => {
  const env = openEnv();
  try {
    const shinano = env.repo.createAvatar({ name: "Shinano", kind: "avatar" });
    const manuka = env.repo.createAvatar({ name: "Manuka", kind: "avatar" });
    const item = env.repo.createItem({ title: "Shinano Outfit", source_site: "local", status: "inbox" });

    const o1 = await matchItem(env.repo, item.id);
    assert.ok(o1.addedItem >= 1, "正例：真实 auto 命中必须产生新增");
    const autoRow = env.repo.listItemAvatars(item.id).find((r: any) => Number(r.avatar_id) === shinano.id);
    assert.ok(autoRow, "Shinano 应被 auto 标注");
    assert.equal(autoRow.source, "auto");

    env.repo.setItemAvatars(item.id, [manuka.id], "manual", "any", 0.42, "manual:keep");
    env.repo.updateItem(item.id, { title: "Manuka Outfit" });
    const o2 = await matchItem(env.repo, item.id);
    assert.equal(o2.removedItem, 1, "auto 对照必须可观察变化（旧 auto 行被校准删除）");

    const rows = env.repo.listItemAvatars(item.id);
    const m = rows.find((r: any) => Number(r.avatar_id) === manuka.id);
    assert.ok(m, "manual 行必须保留");
    assert.equal(m.source, "manual");
    assert.equal(m.confidence, 0.42);
    assert.equal(m.match, "any");
    assert.equal(m.evidence, "manual:keep");
    assert.equal(rows.some((r: any) => Number(r.avatar_id) === shinano.id), false, "auto 行应被删除");
  } finally { await env.close(); }
});
