#!/usr/bin/env node
/**
 * v0.6.1-F 成本拆解基准（verifier / task-12）
 *
 * 目的：在**不改实现**的前提下，把 v0.6.0 流水线的固定成本拆开：
 *   发现 / 建档 / 每阶段调度固定成本（claim→execute→finish→refresh→notify）
 *   SQLite 写入与状态更新（按语句桶统计次数与耗时）、事务数、事件记录
 *   缓存快路径（cacheKey / get hit / put / touch）
 *   总耗时、峰值 RSS、事件循环 p95/max
 *
 * 用法：
 *   node --import tsx scripts/bench-costs.mjs --small=500
 *   node --import tsx scripts/bench-costs.mjs --small=500 --legacy
 *   node --import tsx scripts/bench-costs.mjs --small=1000 --repeat=0
 *
 * 口径（写清楚，避免退化指标）：
 *   - 冷缓存：每次运行新建临时目录；第二遍（--repeat=1，默认）在同库上重跑用于缓存观察。
 *   - DB 语句：在 db.prepare 返回的 Statement 上包一层，统计 run/get/all 的**次数与执行耗时**，
 *     并按 "VERB 表名" 分桶；prepare 编译耗时单独统计。
 *   - 每任务固定成本 = 索引阶段墙钟 / 完成任务数；其中 stageMs 来自 pipeline.stats()（阶段工作 + finish + 进度 flush），
 *     调度开销 = 索引墙钟 - ΣstageMs（claim、refreshAssetState、notify、worker 等待、drain 轮询）。
 *   - worker 轮询：给 claimIndexTask / notify / sleep 打点，区分"被 notify 唤醒"与"250ms 超时"。
 *   - 事件循环：50ms 定时器实际间隔 - 50 的 p95/max（>200ms 说明主线程被同步操作堵住）。
 *   - 峰值 RSS：100ms 采样。
 *
 * 注意：插桩会带来少量额外开销（Proxy 分派 + performance.now），用于**相对成本归因**；
 * 绝对吞吐请以未插桩的 scripts/bench-pipeline.mjs 为准。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { openDatabase } from "../apps/server/src/db/migrate.ts";
import { Repo } from "../apps/server/src/db/repo.ts";
import { MediaStore } from "../apps/server/src/services/media.ts";
import { DerivedCache, cacheKey } from "../apps/server/src/services/pipeline/cache.ts";
import { IndexPipeline } from "../apps/server/src/services/pipeline/pipeline.ts";
import { DEFAULT_LIMITS, resolveLimits } from "../apps/server/src/services/pipeline/limits.ts";
import { walkCandidates, planFromFiles, registerAssets } from "../apps/server/src/services/scan.ts";
import { indexAsset } from "../apps/server/src/services/indexing.ts";
import { probeImage, makeThumbnail } from "../packages/core/src/images.ts";
import { matchItem } from "../apps/server/src/services/match.ts";
import { applyCategoryEvidence } from "../apps/server/src/services/categories.ts";

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
  const [k, v] = a.slice(2).split("="); return [k, v === undefined ? true : v];
}));
const SMALL = Number(args.small ?? 500);
const LEGACY = !!args.legacy;
const REPEAT = args.repeat === undefined ? 1 : Number(args.repeat);
const KEEP = !!args.keep;
/** 夹具 preview.png：padded = 与 bench-pipeline 同构（1x1 + 20KB 填充，sharp 缩略图会失败）；valid = 64x64 噪声（真实可解码，~16KB）。 */
const VALID_IMAGES = !!args.valid;
const TMP = mkdtempSync(join(tmpdir(), "av-costs-"));
const LIB = join(TMP, "lib");
const DATA = join(TMP, "data");
mkdirSync(LIB, { recursive: true }); mkdirSync(DATA, { recursive: true });

// ---------- 夹具：与 bench-pipeline 同构的 N 个小 zip（每个含 1 张 20KB png）----------
const py = String.raw`import zipfile, io, os, sys, zlib, struct, binascii, random
lib = sys.argv[1]; small = int(sys.argv[2]); mode = sys.argv[3]; root = sys.argv[4]

def chunk(t, d):
    c = t + d
    return struct.pack('>I', len(d)) + c + struct.pack('>I', binascii.crc32(c) & 0xffffffff)
def valid_png(w=64, h=64, seed=1):
    random.seed(seed)
    raw = b''
    for y in range(h):
        raw += b'\x00' + bytes(random.randrange(256) for _ in range(w * 4))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))

png = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f6c0000000049454e44ae426082')
open(os.path.join(root, 'sample-valid.png'), 'wb').write(valid_png())
img = valid_png() if mode == 'valid' else (png + b'\0' * 20000)
d = os.path.join(lib, 'small'); os.makedirs(d, exist_ok=True)
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('readme.txt', 'hello')
    z.writestr('preview.png', img)
blob = buf.getvalue()
for i in range(small):
    open(os.path.join(d, 'pack-%05d.zip' % i), 'wb').write(blob)
print('fixtures ok mode=%s preview=%dB' % (mode, len(img)))
`;
const fx = spawnSync("python3", ["-", LIB, String(SMALL), VALID_IMAGES ? "valid" : "padded", TMP], { input: py, encoding: "utf8" });
if (fx.status !== 0) { console.error(fx.stderr || fx.stdout); process.exit(1); }
console.log((fx.stdout || "").trim());

// ---------- DB 插桩 ----------
const dbStat = new Map(); // bucket -> {count, ms}
let prepareCount = 0, prepareMs = 0, txCount = 0, txMs = 0, execCount = 0, execMs = 0;
function bucketOf(sql) {
  const s = String(sql).replace(/\s+/g, " ").trim();
  const verb = (s.match(/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|WITH)\b/i)?.[1] ?? "OTHER").toUpperCase();
  const m = s.match(/\b(?:FROM|INTO|UPDATE|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/i);
  return verb + " " + (m ? m[1] : "?");
}
function note(bucket, dt) {
  const b = dbStat.get(bucket) ?? { count: 0, ms: 0 };
  b.count++; b.ms += dt; dbStat.set(bucket, b);
}
function instrumentDb(db) {
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const t0 = performance.now();
    const st = origPrepare(sql);
    prepareCount++; prepareMs += performance.now() - t0;
    const bucket = bucketOf(sql);
    return new Proxy(st, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (typeof v !== "function") return v;
        if (prop === "run" || prop === "get" || prop === "all") {
          return function (...a) { const t = performance.now(); try { return v.apply(target, a); } finally { note(bucket, performance.now() - t); } };
        }
        return v.bind(target);
      },
    });
  };
  const origTx = db.transaction.bind(db);
  db.transaction = (fn) => { const tx = origTx(fn); return (...a) => { const t = performance.now(); try { return tx(...a); } finally { txCount++; txMs += performance.now() - t; } }; };
  const origExec = db.exec.bind(db);
  db.exec = (sql) => { const t = performance.now(); try { return origExec(sql); } finally { execCount++; execMs += performance.now() - t; } };
}
const resetCounters = () => { dbStat.clear(); prepareCount = prepareMs = txCount = txMs = execCount = execMs = 0; };
const summary = () => {
  const rows = [...dbStat.entries()].map(([bucket, v]) => ({ bucket, count: v.count, ms: Number(v.ms.toFixed(1)) }))
    .sort((a, b) => b.ms - a.ms);
  const total = rows.reduce((n, r) => n + r.count, 0);
  return { totalStatements: total, prepare: { count: prepareCount, ms: Number(prepareMs.toFixed(1)) }, tx: { count: txCount, ms: Number(txMs.toFixed(1)) }, exec: { count: execCount, ms: Number(execMs.toFixed(1)) }, rows };
};

// ---------- 打开库/流水线 ----------
const db = openDatabase(join(DATA, "vault.db"));
instrumentDb(db);
const repo = new Repo(db);
const media = new MediaStore(join(DATA, "media"));
const cache = new DerivedCache(join(DATA, "cache"), repo, () => {});
const limits = resolveLimits({ ...DEFAULT_LIMITS, hashConcurrency: 2, archiveConcurrency: 1, thumbConcurrency: 2 });
const pipeline = new IndexPipeline({ repo, media, cache, limits, log: () => {} });

// ---------- 调度插桩 ----------
const sched = { claimCalls: 0, claimNull: 0, claimMs: 0, notify: 0, refreshCalls: 0, refreshMs: 0, getAssetCalls: 0, getAssetMs: 0, sleepNotify: 0, sleepTimeout: 0, sleepMs: 0, enqueueCalls: 0, enqueueMs: 0, countIndexCalls: 0, countIndexMs: 0 };
const timed = (bucket, fn) => { const t = performance.now(); try { return fn(); } finally { bucket === "claim" ? sched.claimMs += performance.now() - t : bucket === "enqueue" ? sched.enqueueMs += performance.now() - t : bucket === "getAsset" ? sched.getAssetMs += performance.now() - t : sched.countIndexMs += performance.now() - t; } };
const origClaim = repo.claimIndexTask.bind(repo);
repo.claimIndexTask = (stage) => { sched.claimCalls++; const r = timed("claim", () => origClaim(stage)); if (!r) sched.claimNull++; return r; };
const origEnqueue = repo.enqueueIndexTask.bind(repo);
repo.enqueueIndexTask = (input) => { sched.enqueueCalls++; return timed("enqueue", () => origEnqueue(input)); };
const origGetAsset = repo.getAsset.bind(repo);
repo.getAsset = (id) => { sched.getAssetCalls++; return timed("getAsset", () => origGetAsset(id)); };
const origCountIndex = repo.countIndexTasks.bind(repo);
repo.countIndexTasks = () => { sched.countIndexCalls++; return timed("countIndex", () => origCountIndex()); };
const P = IndexPipeline.prototype;
const origNotify = P.notify;
P.notify = function () { sched.notify++; return origNotify.call(this); };
const origSleep = P.sleep;
P.sleep = async function (ms) {
  const t0 = performance.now();
  const r = await origSleep.call(this, ms);
  const dt = performance.now() - t0;
  sched.sleepMs += dt;
  if (dt >= ms - 5) sched.sleepTimeout++; else sched.sleepNotify++;
  return r;
};
const origRefresh = P.refreshAssetState;
P.refreshAssetState = function (id) { sched.refreshCalls++; const t = performance.now(); try { return origRefresh.call(this, id); } finally { sched.refreshMs += performance.now() - t; } };
// 事件循环尖峰按"当时正在执行的阶段"归因（execute 是私有方法，但运行时在 prototype 上）
let currentStage = null;
const origExecute = P.execute;
P.execute = async function (stage, task) { const prev = currentStage; currentStage = stage; try { return await origExecute.call(this, stage, task); } finally { currentStage = prev; } };

// ---------- RSS / 事件循环 ----------
let peakRss = 0;
const rssTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
const lags = []; let phase = "startup"; let lastTick = performance.now();
const lagTimer = setInterval(() => {
  const now = performance.now();
  lags.push({ lag: now - lastTick - 50, phase, stage: currentStage });
  lastTick = now;
}, 50);

// ---------- 注册（发现 + 建档）----------
pipeline.start();
const rootId = repo.ensureRoot(LIB, "index_in_place").id;
phase = "discover";
const tWalk0 = performance.now();
const scan = await walkCandidates(LIB, { maxDepth: 8, limit: 100000 });
const tWalk = performance.now() - tWalk0;
phase = "register";
resetCounters();
const tReg0 = performance.now();
const plans = planFromFiles(LIB, scan.filesOut);
const assetIds = [];
for (const plan of plans) {
  const item = repo.createItem({ title: plan.title, source_site: "local", status: "inbox" });
  for (const a of plan.assets) assetIds.push(registerAssets(repo, rootId, LIB, item.id, a.file, "scan").id);
}
const tReg = performance.now() - tReg0;
const regStats = summary();

// ---------- 索引（legacy vs pipeline）----------
phase = "index";
resetCounters();
Object.assign(sched, { claimCalls: 0, claimNull: 0, claimMs: 0, notify: 0, refreshCalls: 0, refreshMs: 0, getAssetCalls: 0, getAssetMs: 0, sleepNotify: 0, sleepTimeout: 0, sleepMs: 0, enqueueCalls: 0, enqueueMs: 0, countIndexCalls: 0, countIndexMs: 0 });
const tIdx0 = performance.now();
let settled = true;
if (LEGACY) {
  for (const id of assetIds) {
    try {
      const a = repo.getAsset(id);
      await indexAsset(repo, media, id, { cache, limits });
      if (a) { await matchItem(repo, a.item_id, {}); applyCategoryEvidence(repo, a.item_id); repo.syncFts(a.item_id); }
    } catch { /* 与 0.5.1 串行路径一致：单资产失败不阻断 */ }
  }
} else {
  for (const id of assetIds) pipeline.enqueueAsset(id, { priority: 50 });
  settled = await pipeline.drain(30 * 60 * 1000);
}
const tIdx = performance.now() - tIdx0;
const stats1 = pipeline.stats();
const idxStats = summary();
const idxSched = { ...sched };

// ---------- 第二遍（缓存快路径）----------
let second = null;
if (REPEAT > 0 && !LEGACY) {
  phase = "second";
  resetCounters();
  Object.assign(sched, { claimCalls: 0, claimNull: 0, claimMs: 0, notify: 0, refreshCalls: 0, refreshMs: 0, getAssetCalls: 0, getAssetMs: 0, sleepNotify: 0, sleepTimeout: 0, sleepMs: 0, enqueueCalls: 0, enqueueMs: 0, countIndexCalls: 0, countIndexMs: 0 });
  const t2 = performance.now();
  for (const id of assetIds) pipeline.enqueueAsset(id, { priority: 10 });
  const settled2 = await pipeline.drain(30 * 60 * 1000);
  const t2ms = performance.now() - t2;
  second = { ms: Math.round(t2ms), settled: settled2, stats: pipeline.stats().cache, db: summary(), sched: { ...sched } };
}
clearInterval(rssTimer); clearInterval(lagTimer);
await pipeline.stop();

// ---------- 微基准（同一库、同一缓存）----------
const micro = {};
const measure = async (name, n, fn) => {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await fn(i);
  const ms = performance.now() - t0;
  micro[name] = { n, totalMs: Number(ms.toFixed(1)), usPerOp: Number(((ms * 1000) / n).toFixed(2)) };
};
// 用前 300 个资产测 enqueue/claim/finish/update 的单项成本
const sample = assetIds.slice(0, Math.min(300, assetIds.length));
await measure("enqueueIndexTask", sample.length, (i) => repo.enqueueIndexTask({ assetId: sample[i], stage: "cost-" + i, priority: 1 }));
const taskIds = sample.map((id, i) => repo.enqueueIndexTask({ assetId: id, stage: "cost2-" + i, priority: 1 }));
await measure("claimIndexTask(empty)", Math.max(50, sample.length), () => repo.claimIndexTask("no-such-stage"));
await measure("finishIndexTask", taskIds.length, (i) => repo.finishIndexTask(taskIds[i], "done", {}, { requireRunning: false }));
await measure("updateIndexTask(progress)", taskIds.length, (i) => repo.updateIndexTask(taskIds[i], { bytesDone: i, itemsDone: 1 }));
await measure("listIndexTasks(1 asset)", sample.length, (i) => repo.listIndexTasks({ assetId: sample[i], limit: 50 }));
await measure("setAssetIndexState", sample.length, (i) => repo.setAssetIndexState(sample[i], "done", null));
await measure("countActiveIndexTasks(1)", sample.length, (i) => repo.countActiveIndexTasks([sample[i]]));
await measure("logPipelineEvent", Math.max(100, sample.length), (i) => repo.logPipelineEvent({ assetId: sample[i % sample.length], stage: "cost", event: "bench", detail: String(i) }));
const itemIds = db.prepare("SELECT id FROM items LIMIT 200").all().map((r) => r.id);
await measure("syncFts(item)", itemIds.length || 1, (i) => repo.syncFts(itemIds[i % (itemIds.length || 1)]));
// 缓存快路径
const key = cacheKey({ kind: "bench", identity: "sha256:abc", versionKey: "v1" });
await cache.put("bench", key, { entries: Array.from({ length: 50 }, (_, i) => ({ path: "Assets/a" + i + ".prefab", size: i })) }, { kind: "bench", versionKey: "v1" });
await measure("cacheKey", 20000, (i) => cacheKey({ kind: "bench", identity: "sha256:" + (i % 10), versionKey: "v1" }));
await measure("cache.get(hit)", 200, () => cache.get("bench", key));
await measure("cache.put(50 entries)", 200, () => cache.put("bench", key, { entries: Array.from({ length: 50 }, (_, i) => ({ path: "Assets/a" + i + ".prefab", size: i })) }, { kind: "bench", versionKey: "v1" }));
await measure("cache.touch(DB)", 500, () => repo.touchCacheEntry(key));
// 图片管线：probeImage（读元数据）+ makeThumbnail（解码+缩放+webp 编码）在 saveImage 里是两次独立解码
const sampleImg = join(TMP, "sample-valid.png");
if (existsSync(sampleImg)) {
  const buf = readFileSync(sampleImg);
  await measure("probeImage(64x64)", 100, () => probeImage(buf));
  await measure("makeThumbnail(512,webp)", 100, () => makeThumbnail(buf, { maxSize: 512, format: "webp" }));
  await measure("media.saveImage(probe+thumb)", 100, () => media.saveImage(999999, buf, "png", { maxSize: 512 }));
}

// ---------- 汇总 ----------
const stageMs = (s, name) => { const x = s.stages.find((z) => z.stage === name); return x && x.avgMs ? x.avgMs * x.done : 0; };
const sumStageMs = stats1.stages.reduce((n, x) => n + (x.avgMs ?? 0) * x.done, 0);
const doneTasks = stats1.done + stats1.skipped;
const lagSorted = lags.map((x) => x.lag).sort((a, b) => a - b);
const p95 = Math.round(lagSorted[Math.floor(lagSorted.length * 0.95)] ?? 0);
const maxLag = Math.round(lagSorted[lagSorted.length - 1] ?? 0);
const byPhase = {};
for (const x of lags) {
  const b = byPhase[x.phase] ?? (byPhase[x.phase] = { n: 0, max: 0, p95: 0, arr: [] });
  b.n++; b.max = Math.max(b.max, x.lag); b.arr.push(x.lag);
}
for (const k of Object.keys(byPhase)) {
  const a = byPhase[k].arr.sort((x, y) => x - y);
  byPhase[k].p95 = Math.round(a[Math.floor(a.length * 0.95)] ?? 0);
  delete byPhase[k].arr;
}
const byStageLag = {};
for (const x of lags) {
  const k = x.stage ?? "(idle/register)";
  (byStageLag[k] ??= { n: 0, max: 0, arr: [] });
  byStageLag[k].n++; byStageLag[k].max = Math.max(byStageLag[k].max, Math.round(x.lag)); byStageLag[k].arr.push(x.lag);
}
for (const k of Object.keys(byStageLag)) {
  const a = byStageLag[k].arr.sort((x, y) => x - y);
  byStageLag[k].p95 = Math.round(a[Math.floor(a.length * 0.95)] ?? 0);
  delete byStageLag[k].arr;
}

const out = {
  at: new Date().toISOString(),
  mode: LEGACY ? "legacy-serial" : "pipeline",
  env: { node: process.version, platform: process.platform, arch: process.arch, cpus: cpus().length },
  fixture: { small: SMALL, files: scan.files, bytes: scan.bytes, assets: assetIds.length, preview: VALID_IMAGES ? "valid-64x64" : "padded-1x1+20KB" },
  discovery: { ms: Math.round(tWalk), perFileUs: Number(((tWalk * 1000) / Math.max(1, scan.files)).toFixed(1)), filesPerSec: Math.round(scan.files / (tWalk / 1000)) },
  register: {
    ms: Math.round(tReg), perAssetUs: Number(((tReg * 1000) / Math.max(1, assetIds.length)).toFixed(1)),
    assetsPerSec: Math.round(assetIds.length / (tReg / 1000)),
    db: regStats,
    perAssetStatements: Number((regStats.totalStatements / Math.max(1, assetIds.length)).toFixed(2)),
  },
  index: {
    ms: Math.round(tIdx), settled,
    tasks: { done: stats1.done, skipped: stats1.skipped, failed: stats1.failed, cancelled: stats1.cancelled, total: doneTasks },
    perAssetMs: Number((tIdx / Math.max(1, assetIds.length)).toFixed(2)),
    perTaskMs: Number((tIdx / Math.max(1, doneTasks)).toFixed(2)),
    stageMs: stats1.stages.map((s) => ({ stage: s.stage, done: s.done, avgMs: s.avgMs, totalMs: Math.round(stageMs(stats1, s.stage)) })),
    sumStageMs: Math.round(sumStageMs),
    parallelism: Number((sumStageMs / Math.max(1, tIdx)).toFixed(2)),
    scheduler: {
      claimMs: Math.round(idxSched.claimMs), claimCalls: idxSched.claimCalls, claimNull: idxSched.claimNull,
      claimUsPerTask: Number(((idxSched.claimMs * 1000) / Math.max(1, doneTasks)).toFixed(1)),
      nullPollAmplification: Number((idxSched.claimNull / Math.max(1, doneTasks)).toFixed(2)),
      getAssetMs: Math.round(idxSched.getAssetMs), getAssetCalls: idxSched.getAssetCalls,
      refreshMs: Math.round(idxSched.refreshMs), refreshCalls: idxSched.refreshCalls,
      refreshUsPerTask: Number(((idxSched.refreshMs * 1000) / Math.max(1, doneTasks)).toFixed(1)),
      enqueueMs: Math.round(idxSched.enqueueMs), enqueueCalls: idxSched.enqueueCalls,
      countIndexCalls: idxSched.countIndexCalls, countIndexMs: Math.round(idxSched.countIndexMs),
      notify: idxSched.notify,
      sleepNotify: idxSched.sleepNotify, sleepTimeout: idxSched.sleepTimeout, sleepMs: Math.round(idxSched.sleepMs),
      fixedUsPerTask: Number((((idxSched.claimMs + idxSched.getAssetMs + idxSched.refreshMs) * 1000) / Math.max(1, doneTasks)).toFixed(1)),
    },
    db: idxStats,
    dbPerTask: { statements: Number((idxStats.totalStatements / Math.max(1, doneTasks)).toFixed(2)), ms: Number((idxStats.rows.reduce((n, r) => n + r.ms, 0) / Math.max(1, doneTasks)).toFixed(2)) },
    dbPerAsset: { statements: Number((idxStats.totalStatements / Math.max(1, assetIds.length)).toFixed(2)) },
  },
  secondPass: second,
  memory: { peakRssMB: Math.round(peakRss / 1048576) },
  eventLoop: { p95Ms: p95, maxMs: maxLag, samples: lags.length, byPhase, byStage: byStageLag },
  micro,
  cacheStats: cache.stats(limits.cacheMaxBytes),
};
mkdirSync(join(process.cwd(), "logs"), { recursive: true });
const file = join(process.cwd(), "logs", "bench-costs-" + out.mode + "-" + SMALL + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log("\nwrote " + file + (KEEP ? " (fixtures kept at " + TMP + ")" : ""));
db.close();
if (!KEEP) rmSync(TMP, { recursive: true, force: true });