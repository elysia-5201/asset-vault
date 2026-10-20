/**
 * mock 版索引流水线 —— 只服务 ?mock=1 / 后端不可达时的演示与自测。
 * 形状严格对齐 lead 冻结的 GET /api/pipeline*，字段名一个不改；
 * 状态用字符串字面量（对齐 PipelineTaskState），retry/cancel 就地改任务并追加事件。
 */
import type { PipelineEvent, PipelineOverview, PipelineStage, PipelineStageStat, PipelineTask } from "../types";

type Res = { status: number; body: unknown };
const nowIso = (): string => new Date().toISOString();
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

const STAGES: PipelineStage[] = ["hash", "archive", "unitypackage", "thumbs", "meta", "categorize", "fts"];
const startedAt = iso(12 * 60 * 1000);
let paused = false;
let seq = 500;
const nextId = (): number => ++seq;

function mk(t: Partial<PipelineTask> & { id: number; asset_id: number; stage: string; state: string }): PipelineTask {
  return {
    item_id: null, priority: 0, attempts: 0, max_attempts: 4,
    bytes_done: 0, bytes_total: null, items_done: 0, items_total: null,
    error_code: null, error: null, created_at: iso(60 * 1000), started_at: null, finished_at: null,
    next_retry_at: null, path: null, size: null, ...t,
  };
}

const tasks: PipelineTask[] = [
  mk({ id: 101, asset_id: 3, item_id: 1, stage: "hash", state: "running", priority: 5,
    bytes_done: 3_355_443, bytes_total: 9_857_024, started_at: iso(3200),
    path: "/mnt/e/game/vrchatcache/MANUKA_ver1.02/MANUKA.unitypackage", size: 9_857_024 }),
  mk({ id: 102, asset_id: 3, item_id: 1, stage: "archive", state: "queued", priority: 5, items_total: 678 }),
  mk({ id: 103, asset_id: 3, item_id: 1, stage: "unitypackage", state: "queued", priority: 5, items_total: 165 }),
  mk({ id: 104, asset_id: 8, item_id: 2, stage: "thumbs", state: "waiting_retry", attempts: 2, priority: 3,
    items_total: 24, items_done: 6, next_retry_at: new Date(Date.now() + 30_000).toISOString(),
    error_code: "ETIMEDOUT", error: "sharp 解码超时（第 2 次，30s 后重试）",
    path: "/mnt/e/game/vrchatcache/素材库/[19 Avatars] citrus shop Soft R18 Texture.7z", size: 1_288_490_188 }),
  mk({ id: 105, asset_id: 12, item_id: 4, stage: "meta", state: "failed", attempts: 4, priority: 2,
    error_code: "ENOENT", error: "资产文件已被移动：/mnt/e/game/vrchatcache/素材库/OLD/broken.zip",
    path: "/mnt/e/game/vrchatcache/素材库/OLD/broken.zip", size: 402_653 }),
  mk({ id: 106, asset_id: 12, item_id: 4, stage: "categorize", state: "failed", attempts: 4, priority: 2,
    error_code: "EAI_AGAIN", error: "分类推荐上游超时（重试已用尽）" }),
  mk({ id: 107, asset_id: 9, item_id: 3, stage: "thumbs", state: "done", attempts: 0, priority: 1,
    items_done: 8, items_total: 8, started_at: iso(90_000), finished_at: iso(84_000) }),
  mk({ id: 108, asset_id: 9, item_id: 3, stage: "fts", state: "done", attempts: 1, priority: 1,
    items_done: 120, items_total: 120, started_at: iso(80_000), finished_at: iso(78_000) }),
  mk({ id: 109, asset_id: 15, item_id: null, stage: "hash", state: "skipped", priority: 0,
    path: "/mnt/e/game/vrchatcache/素材库/免费素材/readme.txt", size: 128 }),
  mk({ id: 110, asset_id: 16, item_id: 5, stage: "archive", state: "cancelled", attempts: 1, priority: 0,
    started_at: iso(200_000), finished_at: iso(190_000), path: "/mnt/e/game/vrchatcache/素材库/大包.rar" }),
];

const events: PipelineEvent[] = [
  { id: 1, at: iso(3600 * 1000), task_id: null, asset_id: null, item_id: null, stage: null, event: "started", detail: "worker 启动" },
  { id: 2, at: iso(320_000), task_id: 101, asset_id: 3, item_id: 1, stage: "hash", event: "enqueued", detail: null },
  { id: 3, at: iso(300_000), task_id: 101, asset_id: 3, item_id: 1, stage: "hash", event: "started", detail: null },
  { id: 4, at: iso(240_000), task_id: 104, asset_id: 8, item_id: 2, stage: "thumbs", event: "retry_scheduled", detail: "sharp 解码超时" },
  { id: 5, at: iso(200_000), task_id: 105, asset_id: 12, item_id: 4, stage: "meta", event: "failed", detail: "ENOENT: 资产文件已被移动" },
  { id: 6, at: iso(120_000), task_id: 106, asset_id: 12, item_id: 4, stage: "categorize", event: "failed", detail: "EAI_AGAIN: 分类推荐上游超时" },
  { id: 7, at: iso(84_000), task_id: 107, asset_id: 9, item_id: 3, stage: "thumbs", event: "done", detail: "8/8" },
  { id: 8, at: iso(78_000), task_id: 108, asset_id: 9, item_id: 3, stage: "fts", event: "done", detail: "120/120" },
  { id: 9, at: iso(3200), task_id: 101, asset_id: 3, item_id: 1, stage: "hash", event: "progress", detail: "3.2MB / 9.4MB" },
];
let evSeq = events.length;

function pushEvent(t: PipelineTask | null, event: string, detail: string | null): void {
  events.push({
    id: ++evSeq, at: nowIso(),
    task_id: t ? t.id : null, asset_id: t ? t.asset_id : null, item_id: t ? t.item_id : null,
    stage: t ? String(t.stage) : null, event, detail,
  });
}

function stageStats(): PipelineStageStat[] {
  return STAGES.map((stage) => {
    const rows = tasks.filter((t) => t.stage === stage);
    const avg = rows
      .filter((t) => t.started_at && t.finished_at)
      .map((t) => Date.parse(t.finished_at!) - Date.parse(t.started_at!))
      .filter((n) => Number.isFinite(n) && n >= 0);
    return {
      stage,
      queued: rows.filter((t) => t.state === "queued").length,
      running: rows.filter((t) => t.state === "running").length,
      waitingRetry: rows.filter((t) => t.state === "waiting_retry").length,
      failed: rows.filter((t) => t.state === "failed").length,
      done: rows.filter((t) => t.state === "done").length,
      skipped: rows.filter((t) => t.state === "skipped").length,
      avgMs: avg.length ? Math.round(avg.reduce((a, b) => a + b, 0) / avg.length) : null,
    };
  });
}

function overview(): PipelineOverview {
  const count = (s: string): number => tasks.filter((t) => t.state === s).length;
  const failedLast = tasks.filter((t) => t.state === "failed").sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  return {
    started: true, paused, startedAt,
    running: count("running"), queued: count("queued"), waitingRetry: count("waiting_retry"),
    failed: count("failed"), done: count("done"), cancelled: count("cancelled"), skipped: count("skipped"),
    stages: stageStats(),
    cache: { entries: 128, bytes: 43_916_288, hits: 913, hitRate: 0.873, maxBytes: 536_870_912 },
    memory: { rss: 196_083_712, heapUsed: 67_108_864, heapTotal: 100_663_296, external: 12_582_912 },
    processed: 1024, failures: 3,
    lastError: failedLast
      ? { at: failedLast.finished_at ?? failedLast.created_at, stage: String(failedLast.stage), assetId: failedLast.asset_id, message: failedLast.error ?? "未知错误" }
      : null,
    limits: { maxEntries: 200_000, maxEntryBytes: 2 * 1024 ** 3, maxPixels: 40_000_000, maxRatio: 120, maxDepth: 3, timeoutMs: 30_000 },
    nonDefaultLimits: { timeoutMs: 60_000 },
  };
}

export function mockPipelineHandle(method: string, rawPath: string, query: URLSearchParams, body: unknown): Res {
  const path = rawPath.replace(/^\/api/, "");
  const seg = path.split("/").filter(Boolean);          // ["pipeline", ...]
  const M = method.toUpperCase();
  const b = (body ?? {}) as Record<string, unknown>;
  const tail = seg.slice(1);

  if (tail.length === 0 && M === "GET") return { status: 200, body: overview() };

  if (tail[0] === "tasks") {
    if (tail.length === 1 && M === "GET") {
      let rows = tasks.slice();
      const st = query.get("state");
      const sg = query.get("stage");
      const aid = query.get("assetId");
      if (st) rows = rows.filter((t) => t.state === st);
      if (sg) rows = rows.filter((t) => t.stage === sg);
      if (aid) rows = rows.filter((t) => t.asset_id === Number(aid));
      const limit = Math.max(1, Math.min(500, Number(query.get("limit") ?? 50) || 50));
      return { status: 200, body: { tasks: rows.slice(0, limit) } };
    }
    if (tail.length === 3 && (tail[2] === "retry" || tail[2] === "cancel") && M === "POST") {
      const t = tasks.find((x) => x.id === Number(tail[1]));
      if (!t) return { status: 404, body: { error: { code: "NOT_FOUND", message: "任务 " + tail[1] + " 不存在" } } };
      if (tail[2] === "retry") {
        t.state = "queued"; t.attempts += 1; t.error = null; t.error_code = null; t.next_retry_at = null;
        t.started_at = null; t.finished_at = null;
        pushEvent(t, "retry", "手动重试");
      } else {
        t.state = "cancelled"; t.finished_at = nowIso(); t.next_retry_at = null;
        pushEvent(t, "cancelled", "手动取消");
      }
      return { status: 200, body: { task: t } };
    }
  }

  if (tail[0] === "events" && M === "GET") {
    const after = Number(query.get("after") ?? 0) || 0;
    const limit = Math.max(1, Math.min(500, Number(query.get("limit") ?? 200) || 200));
    return { status: 200, body: { events: events.filter((e) => e.id > after).slice(-limit) } };
  }

  if (tail[0] === "assets" && tail.length === 3 && M === "POST") {
    const assetId = Number(tail[1]);
    const rows = tasks.filter((t) => t.asset_id === assetId);
    if (tail[2] === "reindex") {
      for (const t of rows) {
        t.state = "queued"; t.started_at = null; t.finished_at = null; t.error = null; t.error_code = null;
        t.bytes_done = 0; t.items_done = 0;
      }
      pushEvent(null, "reindex", "资产 " + assetId + " 全阶段重排");
      return { status: 200, body: { queued: rows.length || STAGES.length } };
    }
    if (tail[2] === "boost") {
      const q = rows.filter((t) => t.state === "queued");
      for (const t of q) t.priority = 100;
      return { status: 200, body: { boosted: q.length } };
    }
  }

  if (M === "POST" && (tail[0] === "pause" || tail[0] === "resume")) {
    paused = tail[0] === "pause";
    pushEvent(null, paused ? "paused" : "resumed", null);
    return { status: 200, body: { paused } };
  }

  if (M === "POST" && tail[0] === "gc") {
    const dropped = events.splice(0, Math.max(0, events.length - 20)).length;
    return { status: 200, body: { removed: dropped, bytes: dropped * 4096 } };
  }

  void b;
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "mock 未实现的流水线路由：" + M + " " + path } } };
}
