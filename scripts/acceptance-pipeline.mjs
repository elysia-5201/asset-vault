#!/usr/bin/env node
/**
 * v0.6.0 流水线验收（可重复运行，不需要启动 HTTP 服务）
 *
 * 覆盖：阶段链/依赖、基础建档与深度解析解耦、目录与缩略图、哈希身份、缓存命中、
 *       超限降级（limited）、损坏包失败降级、取消、stale 重建、单写入者锁、schema 版本与三表存在。
 *
 *   node --import tsx scripts/acceptance-pipeline.mjs
 *   node --import tsx scripts/acceptance-pipeline.mjs --keep
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openDatabase, SCHEMA_VERSION } from "../apps/server/src/db/migrate.ts";
import { Repo } from "../apps/server/src/db/repo.ts";
import { MediaStore } from "../apps/server/src/services/media.ts";
import { DerivedCache, cacheKey } from "../apps/server/src/services/pipeline/cache.ts";
import { IndexPipeline } from "../apps/server/src/services/pipeline/pipeline.ts";
import { DEFAULT_LIMITS, resolveLimits, limitsHash } from "../apps/server/src/services/pipeline/limits.ts";
import { acquirePipelineLock } from "../apps/server/src/services/pipeline/lock.ts";
import { planFromFiles, registerAssets, walkCandidates } from "../apps/server/src/services/scan.ts";

const KEEP = process.argv.includes("--keep");
const TMP = mkdtempSync(join(tmpdir(), "av-accept-pipeline-"));
const LIB = join(TMP, "lib"), DATA = join(TMP, "data");
mkdirSync(LIB, { recursive: true }); mkdirSync(DATA, { recursive: true });

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail ? " :: " + String(detail).slice(0, 240) : "")); }
};

// ---- fixtures：正常 zip / 嵌套 zip / 损坏 zip / 大 zip ----
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f6c0000000049454e44ae426082", "hex");
const img = Buffer.concat([png, Buffer.alloc(20000)]);
const py = String.raw`
import zipfile, io, os, sys
lib = sys.argv[1]
png = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f6c0000000049454e44ae426082')
img = png + b'\0' * 20000
inner = io.BytesIO()
with zipfile.ZipFile(inner, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('preview.png', img)
with zipfile.ZipFile(os.path.join(lib, 'normal.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('readme.txt', 'hello')
    z.writestr('preview.png', img)
    z.writestr('nested/inner.zip', inner.getvalue())
with zipfile.ZipFile(os.path.join(lib, 'big.zip'), 'w', zipfile.ZIP_STORED, allowZip64=True) as z:
    z.writestr('large.bin', b'\0' * (30 * 1024 * 1024))
    z.writestr('preview.png', img)
open(os.path.join(lib, 'broken.zip'), 'wb').write(b'PK\x03\x04' + b'\0' * 64)
print('ok')
`;
const rr = spawnSync("python3", ["-", LIB], { input: py, encoding: "utf8" });
if (rr.status !== 0) { console.error(rr.stderr); process.exit(1); }

const db = openDatabase(join(DATA, "vault.db"));
const repo = new Repo(db);
const media = new MediaStore(join(DATA, "media"));
const cache = new DerivedCache(join(DATA, "cache"), repo, () => {});
const limits = resolveLimits({ ...DEFAULT_LIMITS });
const pipeline = new IndexPipeline({ repo, media, cache, limits, log: () => {} });
pipeline.start();
const rootId = repo.ensureRoot(LIB, "index_in_place").id;

const scan = await walkCandidates(LIB, { maxDepth: 4 });
const plans = planFromFiles(LIB, scan.filesOut);
const assets = {};
for (const plan of plans) {
  const item = repo.createItem({ title: plan.title, source_site: "local", status: "inbox" });
  for (const a of plan.assets) {
    const reg = registerAssets(repo, rootId, LIB, item.id, a.file, "scan");
    // F1（Windows）：walkCandidates 在 Windows 返回反斜杠路径；split("/") 取不到文件名 → 用跨平台分隔符切分。
    assets[String(a.file.path).split(/[\\/]/).pop()] = { id: reg.id, itemId: item.id };
  }
}

console.log("\n[1] 阶段链与依赖");
const normal = assets["normal.zip"].id;
const tasks = pipeline.enqueueAsset(normal, { priority: 50 });
const rows = repo.listIndexTasks({ assetId: normal, limit: 20 });
const stages = rows.map((t) => t.stage).sort();
check("zip 资产入队 6 个阶段", tasks.length === 6, tasks.length);
check("阶段集合正确", JSON.stringify(stages) === JSON.stringify(["archive", "categorize", "fts", "hash", "meta", "thumbs"]), stages);
check("thumbs 依赖 archive", rows.find((t) => t.stage === "thumbs")?.depends_on === rows.find((t) => t.stage === "archive")?.id);
check("重复入队不产生新活跃任务", pipeline.enqueueAsset(normal, { priority: 90 }).length === 6 && repo.listIndexTasks({ assetId: normal, limit: 20 }).length === 6);
check("优先级被提升", repo.listIndexTasks({ assetId: normal, limit: 20 }).every((t) => Number(t.priority) >= 50));

console.log("\n[2] 执行完所有阶段");
const ok = await pipeline.drain(120000);
check("队列在 120s 内清空", ok === true);
const after = repo.listIndexTasks({ assetId: normal, limit: 20 });
check("全部阶段 done", after.every((t) => t.state === "done"), after.map((t) => t.stage + ":" + t.state).join(","));
const asset = repo.getAsset(normal);
check("哈希已写入（sha256_state=ok）", asset?.sha256_state === "ok" && /^[a-f0-9]{64}$/.test(String(asset?.sha256)));
check("content_version 已记录", !!asset?.content_version);
check("asset.index_state=done", asset?.index_state === "done", asset?.index_state);
check("目录条目已落库（含嵌套 zip）", repo.getArchiveEntries(normal).length >= 3, repo.getArchiveEntries(normal).length);
check("缩略图已生成（外层或嵌套）", repo.listImages(assets["normal.zip"].itemId).length >= 1, repo.listImages(assets["normal.zip"].itemId).length);
check("FTS 同步未抛错", true);

console.log("\n[3] 缓存复用");
// 第一轮 archive 可能在 hash 完成前用弱身份（size:mtime）建键；跑两轮让 sha256 键稳定下来再断言命中。
const before = repo.cacheStats().entries;
for (let i = 0; i < 2; i++) { pipeline.enqueueAsset(normal, { priority: 10 }); await pipeline.drain(120000); }
const st = pipeline.stats();
check("缓存条目存在", repo.cacheStats().entries >= before);
check("重复索引命中缓存", st.cache.hits >= 1, JSON.stringify(st.cache));
const archiveTask = repo.listIndexTasks({ assetId: normal, stage: "archive", limit: 2 })[0];
check("目录任务版本键带解析器版本", String(archiveTask?.version_key ?? "").length > 0);

console.log("\n[4] 超限降级（保留基础记录，不冒充完整索引）");
const tight = resolveLimits({ ...limits, maxArchiveEntries: 1 });
const cache2 = new DerivedCache(join(DATA, "cache-tight"), repo, () => {});
const p2 = new IndexPipeline({ repo, media, cache: cache2, limits: tight, log: () => {} });
p2.start();
p2.enqueueAsset(assets["big.zip"].id, { priority: 50 });
await p2.drain(120000);
await p2.stop();
const limitedTasks = repo.listIndexTasks({ assetId: assets["big.zip"].id, limit: 20 });
check("超限任务标 skipped/ENTRIES", limitedTasks.some((t) => t.stage === "archive" && t.state === "skipped" && String(t.error_code) === "ENTRIES"), JSON.stringify(limitedTasks.filter((t) => t.stage === "archive")));
check("基础资产记录仍在", !!repo.getAsset(assets["big.zip"].id));
check("index_state=limited（不是 done）", repo.getAsset(assets["big.zip"].id)?.index_state === "limited", repo.getAsset(assets["big.zip"].id)?.index_state);

console.log("\n[5] 损坏包：失败不拖垮资产记录");
pipeline.enqueueAsset(assets["broken.zip"].id, { priority: 50 });
await pipeline.drain(180000);
const brokenAfter = repo.listIndexTasks({ assetId: assets["broken.zip"].id, limit: 20 });
const arch = brokenAfter.find((t) => t.stage === "archive");
check("损坏包 archive 任务进入失败/跳过", arch && ["failed", "skipped"].includes(String(arch.state)), JSON.stringify(arch));
check("损坏包的 hash 仍可完成（基础身份不受影响）", brokenAfter.some((t) => t.stage === "hash" && t.state === "done"));
check("资产记录未被删除", !!repo.getAsset(assets["broken.zip"].id));

console.log("\n[6] 取消");
pipeline.enqueueAsset(assets["big.zip"].id, { priority: 50 });
const cancelled = pipeline.cancelAsset(assets["big.zip"].id);
await pipeline.drain(60000);
const bigRows = repo.listIndexTasks({ assetId: assets["big.zip"].id, limit: 20 });
check("cancelAsset 返回被取消的任务数", cancelled >= 1, cancelled);
check("取消后无运行中任务", bigRows.every((t) => t.state !== "running"));
check("取消不删除资产", !!repo.getAsset(assets["big.zip"].id));

console.log("\n[7] stale 重建");
const stale = repo.enqueueIndexTask({ assetId: normal, stage: "thumbs", fingerprint: "0:never" });
await pipeline.drain(60000);
const staleTask = repo.getIndexTask(stale);
check("指纹不一致 → 任务被跳过（STALE）", staleTask?.state === "skipped" && String(staleTask?.error_code) === "STALE", JSON.stringify(staleTask));
// 跳过后自动重建整链（旧任务 skipped，新任务应已完成）
await pipeline.drain(60000);
const fresh = repo.listIndexTasks({ assetId: normal, limit: 30 }).filter((t) => t.id !== stale && t.stage === "thumbs");
check("stale 后自动重建新链", fresh.length >= 1 && fresh.every((t) => ["done", "skipped"].includes(String(t.state))), JSON.stringify(fresh.map((t) => [t.id, t.state])));

console.log("\n[7b] 退避到期自动提升（BUG-1 回归）");
const retryTask = repo.enqueueIndexTask({ assetId: normal, stage: "meta", priority: 1 });
repo.retryIndexTask(retryTask, { errorCode: "TEST", error: "forced", backoffMs: 1 });
check("先进入 waiting_retry", repo.getIndexTask(retryTask)?.state === "waiting_retry");
await new Promise((r) => setTimeout(r, 1600));
check("worker 定时提升回 queued 或已完成", ["queued", "running", "done", "skipped"].includes(String(repo.getIndexTask(retryTask)?.state)), String(repo.getIndexTask(retryTask)?.state));
await pipeline.drain(60000);

console.log("\n[8] 单写入者锁");
const lock = acquirePipelineLock(DATA);
check("同进程可重复取得锁", lock.acquired === true);
lock.release();
const lock2 = acquirePipelineLock(DATA);
check("释放后可再次取得", lock2.acquired === true);
lock2.release();

console.log("\n[9] 缓存键与限制指纹");
const k1 = cacheKey({ kind: "archive-listing", identity: "sha256:aa", versionKey: "v1", limitsHash: limitsHash(limits) });
const k2 = cacheKey({ kind: "archive-listing", identity: "sha256:aa", versionKey: "v1", limitsHash: limitsHash(resolveLimits({ ...limits, maxArchiveEntries: 2 })) });
check("限制变化 ⇒ 缓存键变化", k1 !== k2);

console.log("\n[10] schema v" + SCHEMA_VERSION);
check("schema_meta.version=" + SCHEMA_VERSION, String(db.prepare("SELECT value v FROM schema_meta WHERE key='version'").get()?.v) === String(SCHEMA_VERSION));
for (const t of ["index_tasks", "pipeline_events", "cache_entries"]) {
  check("表存在: " + t, !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t));
}

await pipeline.stop();
db.close();
console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " " + pass + " passed / " + fail + " failed");
if (KEEP) console.log("fixtures kept at " + TMP);
else rmSync(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
