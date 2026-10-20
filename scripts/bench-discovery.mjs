// scripts/bench-discovery.mjs — v0.6.1-A 审计基准（只读，不写库、不改源码）
//
// 度量定义（避免退化度量）：
//  - discoveryMs：walkCandidates 从进入函数到返回的墙钟时间（含 statSync/readdirSync，不含建树）
//  - filesOutLen：非流式模式下 filesOut 数组长度（=候选数）；流式模式恒为 0（契约）
//  - filesOutHeapKB：walkCandidates 返回后仍被 retains 的堆增量（full 模式含全量 filesOut）
//  - rssHWMKB：进程生命周期峰值 RSS（/proc/self/status VmHWM），每项测量在**独立子进程**里跑，避免互相污染
//  - peakBatchLen：流式模式单批最大条数
// 正/反例对照：
//  - 正例（应随 N 线性）：discoveryMs ≈ c·N（tmpfs 上 stat 为主）
//  - 反例（不应出现）：流式模式 filesOutLen !== 0；full 模式 filesOutHeapKB 不随 N 增长
// 用法：node --import tsx scripts/bench-discovery.mjs            （父进程：建树 + 调度子进程）
//       node --import tsx scripts/bench-discovery.mjs --child --mode discover --root R --streaming 0
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const PARENT = !process.argv.includes("--child");

const arg = (name, def = null) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};
const heapUsed = () => { if (global.gc) global.gc(); return process.memoryUsage().heapUsed; };
const rssHWMKB = () => {
  try {
    const s = readFileSync("/proc/self/status", "utf8");
    const m = /VmHWM:\s+(\d+) kB/.exec(s);
    return m ? Number(m[1]) : null;
  } catch { return null; }
};
/** 当前 RSS（VmRSS），用于"阶段前/后"对照；峰值仍看 rssHWMKB。 */
const rssKB = () => {
  try {
    const s = readFileSync("/proc/self/status", "utf8");
    const m = /VmRSS:\s+(\d+) kB/.exec(s);
    return m ? Number(m[1]) : null;
  } catch { return null; }
};

// ---------------------------------------------------------------- 子进程：discover
async function childDiscover() {
  const root = arg("root");
  const streaming = arg("streaming", "0") === "1";
  const batchSize = Number(arg("batch", "500"));
  const { walkCandidates } = await import("../apps/server/src/services/scan.ts");
  const before = heapUsed();
  let peakBatchLen = 0, batches = 0;
  const t0 = performance.now();
  const st = await walkCandidates(root, {
    maxDepth: Number(arg("maxDepth", "6")),
    ...(streaming ? { batchSize, onBatch: (files) => { batches++; peakBatchLen = Math.max(peakBatchLen, files.length); } } : {}),
  });
  const ms = performance.now() - t0;
  const after = heapUsed();
  console.log(JSON.stringify({
    kind: "discover", streaming, batchSize: streaming ? batchSize : null,
    files: st.files, dirs: st.dirs, dirsRead: st.readability.dirsRead, bytes: st.bytes,
    truncated: st.truncated, complete: st.complete,
    discoveryMs: +ms.toFixed(1), filesOutLen: st.filesOut.length,
    retainedHeapKB: Math.round((after - before) / 1024), batches, peakBatchLen, rssHWMKB: rssHWMKB(),
  }));
}

// ---------------------------------------------------------------- 子进程：memory（纯内存，不碰 FS）
async function childMemory() {
  const n = Number(arg("n", "10000"));
  const dense = arg("dense", "0") === "1";
  const { planFromFiles } = await import("../apps/server/src/services/scan.ts");
  const { normalizePath } = await import("../packages/core/src/pathnorm.ts");
  const h0 = heapUsed();
  const arr = [];
  const count = dense ? n : Math.max(1, Math.floor(n / 10));
  for (let i = 0; i < count; i++) {
    // 贴近真实素材库的路径长度（Windows 绝对路径 + 日文名）
    const p = "C:\\lib\\vrchat\\素材\\" + "item_" + i + "_ミルフィ対応_MilkyWay_ver1.02.zip";
    arr.push({ path: p, size: 1024 + i, mtime: "2026-10-04T02:27:14.000Z", container: "zip", kind: "archive" });
  }
  const h1 = heapUsed();
  const seen = new Set(arr.map((f) => normalizePath(f.path)));
  const h2 = heapUsed();
  const t0 = performance.now();
  const plans = planFromFiles("C:\\lib\\vrchat", arr);
  const planMs = performance.now() - t0;
  const h3 = heapUsed();
  console.log(JSON.stringify({
    kind: "memory", n, dense, candidates: count,
    filesOutHeapKB: Math.round((h1 - h0) / 1024),
    seenSetHeapKB: Math.round((h2 - h1) / 1024),
    plansHeapKB: Math.round((h3 - h2) / 1024), plans: plans.length, planMs: +planMs.toFixed(1),
    rssHWMKB: rssHWMKB(),
  }));
}

// ---------------------------------------------------------------- 子进程：register（批次 commit 成本与幂等）
async function childRegister() {
  const n = Number(arg("n", "10000"));
  const batched = arg("batched", "0") === "1";
  const dbKind = arg("db", "memory");
  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("../apps/server/src/db/migrate.ts");
  const { Repo } = await import("../apps/server/src/db/repo.ts");
  const { registerAssets } = await import("../apps/server/src/services/scan.ts");
  const dbFile = join(tmpdir(), "av-bench-reg-" + process.pid + ".db");
  if (dbKind === "file") rmSync(dbFile, { force: true });
  const db = new Database(dbKind === "file" ? dbFile : ":memory:");
  db.pragma("foreign_keys = ON");
  if (dbKind === "file") db.pragma("journal_mode = WAL");
  migrate(db);
  const repo = new Repo(db);
  const root = repo.ensureRoot("C:\\bench");
  const item = repo.createItem({ title: "bench" });
  const files = [];
  for (let i = 0; i < n; i++) files.push({ path: "C:\\bench\\d" + (i % 50) + "\\f_" + i + ".zip", size: 10 + i, mtime: "2026-10-04T02:27:14.000Z", container: "zip", kind: "archive" });
  const run = () => { let created = 0, changed = 0; for (const f of files) { const r = registerAssets(repo, root.id, "C:\\bench", item.id, f, "scan"); if (r.created) created++; if (r.changed) changed++; } return { created, changed }; };
  const h0 = heapUsed();
  const t0 = performance.now();
  const first = batched ? db.transaction(run)() : run();
  const ms1 = performance.now() - t0;
  const h1 = heapUsed();
  // 重放：同批再跑一次（幂等验证：created 必须为 0，行数不变）
  const t1 = performance.now();
  const replay = batched ? db.transaction(run)() : run();
  const ms2 = performance.now() - t1;
  const rows = db.prepare("SELECT COUNT(*) c FROM assets").get().c;
  const items = db.prepare("SELECT COUNT(*) c FROM items").get().c;
  const dup = db.prepare("SELECT COUNT(*) c FROM (SELECT path_norm FROM assets GROUP BY path_norm HAVING COUNT(*)>1)").get().c;
  console.log(JSON.stringify({ kind: "register", n, dbKind, batched, firstMs: +ms1.toFixed(1), replayMs: +ms2.toFixed(1), loopHeapKB: Math.round((h1 - h0) / 1024), first, replay, assetRows: rows, itemRows: items, duplicatePathNorms: dup, rssHWMKB: rssHWMKB() }));
  db.close();
}

// ---------------------------------------------------------------- 子进程：runner（task-18 验收：跑真实 scan job）
// 度量定义：
//  - scanMs       = runJob(scan job) 从开始到结束的墙钟（含发现/登记/入队/匹配/分类）
//  - rssHWMKB     = 该子进程生命周期峰值 RSS（独立进程，无前序测量污染）
//  - calls.*      = 运行时仪表（包环境对象，不改源码）：upsertAsset 次数/耗时、
//                   是否仍调用 listPresentAssetsUnderPath / presentAssetsUnderPath（旧 seen 路径的指纹）、
//                   入队是逐条（enqueueSingle）还是批量（enqueueBulk）
//  - tempTables   = 本连接里所有 TEMP 表及行数（task-18 的清单表；有行数说明走 TEMP 清单）
// 正/反例对照：
//  正例（B4 落地后）：calls.listPresentAssetsUnderPath === 0、enqueueSingle 很小/为 0、enqueueBulk > 0、tempTables 有行数、assets === n
//  反例（未落地）：calls.listPresentAssetsUnderPath === 1 且 enqueueSingleIds === n（逐条入队）
async function childRunner() {
  const n = Number(arg("n", "20000"));
  const batch = Number(arg("batch", "200"));
  const indexWaitMs = Number(arg("indexWaitMs", "0"));
  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("../apps/server/src/db/migrate.ts");
  const { Repo } = await import("../apps/server/src/db/repo.ts");
  const { MediaStore } = await import("../apps/server/src/services/media.ts");
  const { runJob } = await import("../apps/server/src/jobs/runner.ts");
  const { resolveLimits } = await import("../apps/server/src/services/pipeline/limits.ts");
  const { BoothClient } = await import("../packages/core/src/source/booth.ts");

  // 全 .zip 树：候选数 = n，专门压 filesOut/seen/fileNames/assetIds 这些按候选累积的结构
  const root = join(tmpdir(), "av-bench-runner-" + process.pid);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const dirs = 64;
  for (let d = 0; d < dirs; d++) {
    const dir = join(root, "d" + String(d).padStart(3, "0"));
    mkdirSync(dir, { recursive: true });
    const per = Math.ceil(n / dirs);
    for (let i = 0; i < per && d * per + i < n; i++) writeFileSync(join(dir, "item_" + (d * per + i) + "_素材.zip"), Buffer.alloc(1, 7));
  }

  const dbFile = join(tmpdir(), "av-bench-runner-" + process.pid + ".db");
  rmSync(dbFile, { force: true });
  const db = new Database(dbFile);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  migrate(db);
  const repo = new Repo(db);
  const media = new MediaStore(join(tmpdir(), "av-bench-media-" + process.pid));
  const booth = new BoothClient({ minIntervalMs: 0 });
  // 高水位调大：本次测"有界发现"的内存与契约，不测背压等待
  const limits = resolveLimits({ maxScanFiles: n, registerBatchSize: batch, queueHighWater: 100000000, queueLowWater: 100000000 });

  const calls = {
    upsertAsset: 0, upsertAssetMs: 0,
    listPresentAssetsUnderPath: 0, presentAssetsUnderPath: 0, listAssetsUnderPathSeenBefore: 0,
    enqueueSingle: 0, enqueueSingleIds: 0, enqueueBulk: 0, enqueueBulkIds: 0, enqueueUnknown: 0,
    created: 0, changed: 0,
  };
  for (const m of ["upsertAsset", "listPresentAssetsUnderPath", "presentAssetsUnderPath", "listAssetsUnderPathSeenBefore"]) {
    const orig = repo[m];
    if (typeof orig !== "function") continue;
    repo[m] = function (...a) {
      calls[m]++;
      const t = performance.now();
      const r = orig.apply(this, a);
      const dt = performance.now() - t;
      if (m === "upsertAsset") {
        calls.upsertAssetMs += dt;
        if (r && r.created) calls.created = (calls.created ?? 0) + 1;
        else calls.changed = (calls.changed ?? 0) + 1;
      }
      return r;
    };
  }
  // 镜像生产 IndexPipeline 的真实 API：只有 enqueueAsset / enqueueMany（**没有** enqueueAssets）。
  // runner 的批量分支先探测 enqueueAssets，不存在时落到 enqueueMany —— 这里按生产形态建桩，
  // 避免"测了生产里不存在的方法"。
  const pipelineStub = {
    enqueueAsset: (id) => { calls.enqueueSingle++; calls.enqueueSingleIds++; void id; return []; },
    enqueueMany: (ids) => { calls.enqueueBulk++; calls.enqueueBulkIds += (ids ?? []).length; return (ids ?? []).length; },
    drainAssets: async () => true,
    start() {}, stop() {},
  };
  // 未实现的方法必须返回 undefined（否则 runner 的 typeof p.enqueueAssets === "function"
  // 特征探测会被 Proxy 伪造成"存在"，走到生产里不存在的分支）。探测到未知键只记账名，不伪造函数。
  const probes = [];
  const pipeline = new Proxy(pipelineStub, {
    get(t, k) {
      if (k in t) return t[k];
      probes.push(String(k));
      return undefined;
    },
  });

  const deps = { repo, media, booth, log: () => {}, limits, pipeline };
  let job = repo.createJob("scan", null, { path: root, deep: true, indexWaitMs }, 5);
  const rssBase = rssKB();
  const t0 = performance.now();
  await runJob(deps, job.id);
  const scanMs = performance.now() - t0;
  const finalJob = repo.getJob(job.id);
  // 重放：同一棵树上再跑一次 scan job（模拟失败重试）→ 必须不重复建档、条目数不变
  let replay = null;
  if (arg("replay", "0") === "1") {
    const before = {
      assets: db.prepare("SELECT COUNT(*) c FROM assets").get().c,
      items: db.prepare("SELECT COUNT(*) c FROM items").get().c,
      created: calls.created, changed: calls.changed,
    };
    calls.created = 0; calls.changed = 0;
    const job2 = repo.createJob("scan", null, { path: root, deep: true, indexWaitMs }, 5);
    const t1 = performance.now();
    await runJob(deps, job2.id);
    const ms2 = performance.now() - t1;
    const after = {
      assets: db.prepare("SELECT COUNT(*) c FROM assets").get().c,
      items: db.prepare("SELECT COUNT(*) c FROM items").get().c,
      created: calls.created, changed: calls.changed,
      jobState: repo.getJob(job2.id)?.state ?? null,
      dupPathNorms: db.prepare("SELECT COUNT(*) c FROM (SELECT path_norm FROM assets GROUP BY path_norm HAVING COUNT(*)>1)").get().c,
    };
    replay = { before, after, ms: +ms2.toFixed(0) };
  }
  let tempTables = [];
  try {
    tempTables = db.prepare("SELECT name FROM sqlite_temp_master WHERE type='table'").all().map((r) => {
      let rows = null;
      try { rows = db.prepare("SELECT COUNT(*) c FROM \"" + r.name + "\"").get().c; } catch { rows = null; }
      return { name: r.name, rows };
    });
  } catch { tempTables = []; }
  console.log(JSON.stringify({
    kind: "runner", n, batch, indexWaitMs,
    jobState: finalJob?.state ?? null, jobError: finalJob?.error ?? null,
    assets: db.prepare("SELECT COUNT(*) c FROM assets").get().c,
    items: db.prepare("SELECT COUNT(*) c FROM items").get().c,
    indexTasks: db.prepare("SELECT COUNT(*) c FROM index_tasks").get().c,
    tempTables, calls, probes, replay,
    scanMs: +scanMs.toFixed(0), upsertMs: +calls.upsertAssetMs.toFixed(0),
    rssBaseKB: rssBase, rssHWMKB: rssHWMKB(),
  }));
  db.close();
  rmSync(root, { recursive: true, force: true });
  try { rmSync(dbFile, { force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- 父进程：建树 + 调度
function buildTree(root, n, dense = false) {
  const dirs = 64;
  const t0 = performance.now();
  mkdirSync(root, { recursive: true });
  for (let d = 0; d < dirs; d++) {
    const dir = join(root, "d" + String(d).padStart(3, "0"));
    mkdirSync(dir, { recursive: true });
    const per = Math.ceil(n / dirs);
    for (let i = 0; i < per && d * per + i < n; i++) {
      // 稀疏：10% 候选（zip）+ 90% 非候选（png）；dense：100% 候选（filesOut 上限形态）
      const isCand = dense || (d * per + i) % 10 === 0;
      const name = "item_" + (d * per + i) + "_素材" + (isCand ? ".zip" : ".png");
      writeFileSync(join(dir, name), Buffer.alloc(1, 7));
    }
  }
  return +(performance.now() - t0).toFixed(0);
}

function spawnChild(args) {
  const r = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", SELF, "--child", ...args], {
    cwd: process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 12 * 60 * 1000,
  });
  const out = (r.stdout ?? "").trim().split("\n").filter(Boolean);
  const last = out.length ? out[out.length - 1] : "";
  try { return JSON.parse(last); } catch { return { kind: "error", args, status: r.status, stdout: last.slice(0, 500), stderr: (r.stderr ?? "").slice(0, 800) }; }
}

if (!PARENT) {
  const mode = arg("mode", "discover");
  if (mode === "discover") await childDiscover();
  else if (mode === "memory") await childMemory();
  else if (mode === "register") await childRegister();
  else if (mode === "runner") await childRunner();
  else { console.error("unknown mode " + mode); process.exit(2); }
} else {
  // task-18 验收专用入口：只跑 runner 模式，不改变既有矩阵输出
  if (process.argv.includes("--runner-n")) {
    const rn = Number(arg("runner-n", "20000"));
    const extra = process.argv.includes("--replay") ? ["--replay", "1"] : [];
    const r = spawnChild(["--mode", "runner", "--n", String(rn), "--batch", arg("batch", "200"), "--indexWaitMs", arg("indexWaitMs", "0"), ...extra]);
    console.log("runner n=" + rn + " " + JSON.stringify(r));
    try { writeFileSync("logs/bench-runner.json", JSON.stringify({ at: new Date().toISOString(), runner: r }, null, 1)); console.log("wrote logs/bench-runner.json"); } catch (e) { console.error("write failed: " + e.message); }
    process.exit(0);
  }
  const sizes = (arg("sizes", "10000,50000,100000") ?? "").split(",").map(Number).filter((x) => x > 0);
  const rows = [];
  for (const n of sizes) {
    const root = join(tmpdir(), "av-bench-" + n + "-" + process.pid);
    rmSync(root, { recursive: true, force: true });
    const buildMs = buildTree(root, n);
    const full = spawnChild(["--mode", "discover", "--root", root, "--streaming", "0"]);
    const stream = spawnChild(["--mode", "discover", "--root", root, "--streaming", "1", "--batch", "500"]);
    const mem = spawnChild(["--mode", "memory", "--n", String(n), "--dense", "1"]);
    rows.push({ n, buildMs, full, stream, mem });
    console.log("N=" + n + " buildMs=" + buildMs);
    console.log("  full    " + JSON.stringify(full));
    console.log("  stream  " + JSON.stringify(stream));
    console.log("  memWorst" + JSON.stringify(mem));
    rmSync(root, { recursive: true, force: true });
  }
  const reg = [];
  for (const batched of ["0", "1"]) reg.push(spawnChild(["--mode", "register", "--n", "10000", "--batched", batched]));
  console.log("register(single/batched) " + JSON.stringify(reg));
  // ---- 聚焦测量：dense 10 万候选（filesOut 上限形态） + 落盘 DB 的批次 commit 成本 ----
  const focus = { dense: [], regFile: [] };
  {
    const root = join(tmpdir(), "av-bench-dense-" + process.pid);
    rmSync(root, { recursive: true, force: true });
    const buildMs = buildTree(root, 100000, true);
    const full = spawnChild(["--mode", "discover", "--root", root, "--streaming", "0"]);
    const stream = spawnChild(["--mode", "discover", "--root", root, "--streaming", "1", "--batch", "500"]);
    focus.dense.push({ n: 100000, buildMs, full, stream });
    console.log("dense100k buildMs=" + buildMs);
    console.log("  full    " + JSON.stringify(full));
    console.log("  stream  " + JSON.stringify(stream));
    rmSync(root, { recursive: true, force: true });
  }
  for (const dbKind of ["memory", "file"]) {
    for (const batched of ["0", "1"]) focus.regFile.push(spawnChild(["--mode", "register", "--n", "10000", "--db", dbKind, "--batched", batched]));
  }
  console.log("register(memory/file x single/batched) " + JSON.stringify(focus.regFile));
  const outFile = "logs/bench-discovery.json";
  try { writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), rows, reg, focus }, null, 1)); console.log("wrote " + outFile); } catch (e) { console.error("write failed: " + e.message); }
}
