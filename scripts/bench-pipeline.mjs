#!/usr/bin/env node
/**
 * v0.6.0 流水线基准（可重复运行）
 *
 * 用法:
 *   node --import tsx scripts/bench-pipeline.mjs
 *   node --import tsx scripts/bench-pipeline.mjs --small=1000 --big-mb=100 --keep
 *
 * 测量口径（写清楚，避免退化指标）：
 *   发现     = walkCandidates 枚举 + stat，不含解析；files/s = 候选数 / 秒
 *   建档     = planFromFiles + registerAssets + createItem 的墙钟；items/s
 *   哈希     = hash 阶段 done 任务的 bytes_total 之和 / 该阶段累计耗时
 *   归档     = archive 阶段累计耗时 / 归档数
 *   缩略图   = thumbs 阶段累计耗时 / 成功图数
 *   峰值RSS  = 运行期间每 100ms 采样 process.memoryUsage().rss 的最大值
 *   事件循环 = 每 50ms 定时器的实际间隔 - 50ms 的 p95 / max（>200ms 说明主线程被同步操作堵住）
 *   缓存     = 第二轮回填后的 hitRate（第一轮必然大量 miss，属正常）
 *
 * 数据全部在临时目录生成，结束后删除（--keep 保留并打印路径）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { performance } from "node:perf_hooks";
import { openDatabase } from "../apps/server/src/db/migrate.ts";
import { Repo } from "../apps/server/src/db/repo.ts";
import { MediaStore } from "../apps/server/src/services/media.ts";
import { DerivedCache } from "../apps/server/src/services/pipeline/cache.ts";
import { IndexPipeline } from "../apps/server/src/services/pipeline/pipeline.ts";
import { DEFAULT_LIMITS, resolveLimits, limitsHash } from "../apps/server/src/services/pipeline/limits.ts";
import { walkCandidates, planFromFiles, registerAssets } from "../apps/server/src/services/scan.ts";
import { indexAsset } from "../apps/server/src/services/indexing.ts";
import { matchItem } from "../apps/server/src/services/match.ts";
import { applyCategoryEvidence } from "../apps/server/src/services/categories.ts";
import { normalizePath } from "../packages/core/src/pathnorm.ts";

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
  const [k, v] = a.slice(2).split("="); return [k, v === undefined ? true : v];
}));
const SMALL = Number(args.small ?? 1000);
const BIG_MB = Number(args.bigMb ?? args["big-mb"] ?? 100);
const KEEP = !!args.keep;
/** 对照模式：复现 0.5.1 的"作业内串行内联索引"（同一数据集、同一限制），用于前后对比。 */
const LEGACY = !!args.legacy;
const TMP = mkdtempSync(join(tmpdir(), "av-bench-"));
const LIB = join(TMP, "lib");
const DATA = join(TMP, "data");
mkdirSync(LIB, { recursive: true }); mkdirSync(DATA, { recursive: true });

console.log("fixtures →", TMP, "small=" + SMALL, "big=" + BIG_MB + "MB");

// ---------- 生成素材（python3：zip / 嵌套 zip / unitypackage）----------
const py = String.raw`
import zipfile, io, os, tarfile, sys
lib = sys.argv[1]; small = int(sys.argv[2]); big_mb = int(sys.argv[3])
png = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f6c0000000049454e44ae426082')
# 大一点的图（约 20KB，保证过 >1024 的缩略图门槛）
img = png + b'\0' * 20000
small_dir = os.path.join(lib, 'small'); os.makedirs(small_dir, exist_ok=True)
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('readme.txt', 'hello')
    z.writestr('preview.png', img)
blob = buf.getvalue()
for i in range(small):
    open(os.path.join(small_dir, 'pack-%05d.zip' % i), 'wb').write(blob)
mixed = os.path.join(lib, 'mixed'); os.makedirs(mixed, exist_ok=True)
with zipfile.ZipFile(os.path.join(mixed, 'a-three-images.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
    for n in range(3): z.writestr('img%d.png' % n, img)
    z.writestr('doc/readme.txt', 'x' * 5000)
inner = io.BytesIO()
with zipfile.ZipFile(inner, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('preview.png', img)
with zipfile.ZipFile(os.path.join(mixed, 'b-nested.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('readme.txt', 'outer')
    z.writestr('inner/pkg.zip', inner.getvalue())
big = os.path.join(lib, 'big'); os.makedirs(big, exist_ok=True)
with zipfile.ZipFile(os.path.join(big, 'big-%dmb.zip' % big_mb), 'w', zipfile.ZIP_STORED, allowZip64=True) as z:
    z.writestr('large.bin', b'\0' * (big_mb * 1024 * 1024))
    z.writestr('preview.png', img)
# unitypackage：gzip+tar，<guid>/asset + pathname (+preview.png)
upkg = os.path.join(lib, 'mixed', 'c-package.unitypackage')
with tarfile.open(upkg, 'w:gz') as t:
    for guid, path, has_prev in [('g' * 32, 'Assets/Demo/Readme.txt', True), ('h' * 32, 'Assets/Demo/Mat.mat', False)]:
        for name, data in [('asset', b'payload-' + guid.encode()), ('pathname', path.encode()), ('asset.meta', b'guid: ' + guid.encode())]:
            info = tarfile.TarInfo(guid + '/' + name); info.size = len(data); t.addfile(info, io.BytesIO(data))
        if has_prev:
            info = tarfile.TarInfo(guid + '/preview.png'); info.size = len(img); t.addfile(info, io.BytesIO(img))
print('fixtures ok')
`;
const pyRun = await import("node:child_process");
const r = pyRun.spawnSync("python3", ["-", LIB, String(SMALL), String(BIG_MB)], { input: py, encoding: "utf8" });
if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }
console.log(r.stdout.trim());

// ---------- 打开库与流水线 ----------
const db = openDatabase(join(DATA, "vault.db"));
const repo = new Repo(db);
const media = new MediaStore(join(DATA, "media"));
const cache = new DerivedCache(join(DATA, "cache"), repo, () => {});
const limits = resolveLimits({ ...DEFAULT_LIMITS, hashConcurrency: 2, archiveConcurrency: 1, thumbConcurrency: 2 });
const pipeline = new IndexPipeline({ repo, media, cache, limits, log: () => {} });

let peakRss = 0;
const rssTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
const lags = [];
let phase = "startup";
let lastTick = performance.now();
const lagTimer = setInterval(() => {
  const now = performance.now();
  const m = process.memoryUsage();
  lags.push({ lag: now - lastTick - 50, phase, rss: m.rss, heap: m.heapUsed });
  lastTick = now;
}, 50);
pipeline.start();
const rootId = repo.ensureRoot(LIB, "index_in_place").id;

async function registerAll() {
  const t0 = performance.now();
  const scan = await walkCandidates(LIB, { maxDepth: 8, limit: 100000 });
  const tWalk = performance.now() - t0;
  const t1 = performance.now();
  const plans = planFromFiles(LIB, scan.filesOut);
  const assetIds = [];
  for (const plan of plans) {
    const item = repo.createItem({ title: plan.title, source_site: "local", status: "inbox" });
    for (const a of plan.assets) {
      const reg = registerAssets(repo, rootId, LIB, item.id, a.file, "scan");
      assetIds.push(reg.id);
    }
  }
  const tReg = performance.now() - t1;
  return { scan, assetIds, plans: plans.length, tWalk, tReg };
}

phase = "register";
const first = await registerAll();
console.log("discovered files=" + first.scan.files + " plans=" + first.plans + " assets=" + first.assetIds.length + (LEGACY ? " [legacy serial]" : ""));
phase = "index";
const tIndex0 = performance.now();
let indexed = true;
if (LEGACY) {
  // 复现 0.5.1 runner 的完整串行链路：索引 → 头像匹配 → 自动分类 → FTS
  for (const id of first.assetIds) {
    try {
      const a = repo.getAsset(id);
      await indexAsset(repo, media, id, { cache, limits });
      if (a) { await matchItem(repo, a.item_id, {}); applyCategoryEvidence(repo, a.item_id); repo.syncFts(a.item_id); }
    } catch { /* 单资产失败不阻断（与 runner 旧行为一致） */ }
  }
} else {
  for (const id of first.assetIds) pipeline.enqueueAsset(id, { priority: 50 });
  indexed = await pipeline.drain(30 * 60 * 1000);
}
const tIndex = performance.now() - tIndex0;
const stats1 = pipeline.stats();

phase = "second";
// 第二轮：同资产重复入队（缓存命中观察）
for (const id of first.assetIds) pipeline.enqueueAsset(id, { priority: 10 });
const t2 = performance.now();
const indexed2 = await pipeline.drain(30 * 60 * 1000);
const tIndex2 = performance.now() - t2;
const stats2 = pipeline.stats();

clearInterval(rssTimer); clearInterval(lagTimer);
await pipeline.stop();

const stage = (s, name) => (s.stages.find((x) => x.stage === name) ?? {});
const hashBytes = db.prepare("SELECT COALESCE(SUM(bytes_total),0) b FROM index_tasks WHERE stage='hash' AND state='done'").get().b;
const hashMs = Number(stage(stats1, "hash").avgMs ?? 0) * Number(stage(stats1, "hash").done ?? 0);
const images = Number(stage(stats1, "thumbs").done ?? 0);
const lagSorted = lags.map((x) => x.lag).sort((a, b) => a - b);
const p95 = lagSorted[Math.floor(lagSorted.length * 0.95)] ?? 0;
const maxLag = lagSorted[lagSorted.length - 1] ?? 0;
const byPhase = {};
for (const x of lags) {
  const b = byPhase[x.phase] ?? (byPhase[x.phase] = { p95: 0, max: 0, n: 0 });
  b.max = Math.max(b.max, Math.round(x.lag)); b.n++;
}
for (const k of Object.keys(byPhase)) { const arr = lags.filter((x) => x.phase === k).map((x) => x.lag).sort((a, b) => a - b); byPhase[k].p95 = Math.round(arr[Math.floor(arr.length * 0.95)] ?? 0); }

const out = {
  at: new Date().toISOString(),
  mode: LEGACY ? "legacy-serial" : "pipeline",
  env: { node: process.version, platform: process.platform, arch: process.arch, cpus: (await import("node:os")).cpus().length },
  fixture: { dir: LIB, small: SMALL, bigMb: BIG_MB, files: first.scan.files, bytes: first.scan.bytes, plans: first.plans, assets: first.assetIds.length },
  discovery: { ms: Math.round(first.tWalk), filesPerSec: Math.round(first.scan.files / (first.tWalk / 1000)) },
  register: { ms: Math.round(first.tReg), assetsPerSec: Math.round(first.assetIds.length / (first.tReg / 1000)) },
  index: { ms: Math.round(tIndex), settled: indexed, done: stats1.done, failed: stats1.failed, skipped: stats1.skipped },
  stages: stats1.stages,
  throughput: {
    hashMBps: hashMs > 0 ? Number((Number(hashBytes) / 1024 / 1024 / (hashMs / 1000)).toFixed(2)) : null,
    archiveMs: stage(stats1, "archive").avgMs,
    thumbsMs: stage(stats1, "thumbs").avgMs,
  },
  memory: { peakRssMB: Math.round(peakRss / 1024 / 1024) },
  eventLoop: { p95Ms: Math.round(p95), maxMs: Math.round(maxLag), samples: lags.length, byPhase,
    topSpikes: lags.slice().sort((a, b) => b.lag - a.lag).slice(0, 3).map((x) => ({ lag: Math.round(x.lag), phase: x.phase, rssMB: Math.round(x.rss / 1048576), heapMB: Math.round(x.heap / 1048576) })) },
  cache: { first: stats1.cache, second: stats2.cache },
  secondPass: { ms: Math.round(tIndex2), settled: indexed2, hitRate: stats2.cache.hitRate },
  limitsHash: limitsHash(limits),
};
mkdirSync(join(process.cwd(), "logs"), { recursive: true });
const file = join(process.cwd(), "logs", "bench-v06-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log("\nwrote " + file + (KEEP ? " (fixtures kept at " + TMP + ")" : ""));
db.close();
if (!KEEP) rmSync(TMP, { recursive: true, force: true });
