/**
 * AC 冒烟脚本公共库（verifier / task-4）
 *
 * 约定：
 *  - 每个 test/smoke/acNN-*.ts 都是一条可复现命令：`node --import tsx test/smoke/acNN-xxx.ts`
 *  - 服务未就绪（GET /health 不通）→ 打印 `ACn PENDING` + 就绪后如何跑，退出码 0（pending 不是失败）
 *  - 断言失败 → 打印 `ACn FAIL` + 原始证据，退出码 1
 *  - 全部通过 → 打印 `ACn PASS` + 原始关键数据，退出码 0
 *  - BASE 可用 AV_BASE 覆盖（默认 http://127.0.0.1:7317/api）
 */
export const BASE = (process.env.AV_BASE ?? "http://127.0.0.1:7317/api").replace(/\/$/, "");
export const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
export const DEFAULT_TIMEOUT_MS = Number(process.env.AV_SMOKE_TIMEOUT_MS ?? 120_000);

export type Json = any;

export class AcFailure extends Error { constructor(msg: string) { super(msg); this.name = "AcFailure"; } }
export class AcPending extends Error { constructor(msg: string) { super(msg); this.name = "AcPending"; } }

export function assertAc(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new AcFailure(msg);
}
export function near(actual: number, expected: number, tol: number, label: string): void {
  assertAc(Math.abs(actual - expected) <= tol, `${label}: 期望 ${expected}±${tol}，实际 ${actual}`);
}

export function log(...a: unknown[]): void { console.log(...a); }

export interface Res<T = Json> { status: number; body: T; ms: number; url: string }

export const api = {
  async req<T = Json>(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Res<T>> {
    const url = path.startsWith("http") ? path : BASE + path;
    const t0 = performance.now();
    let r: Response;
    try {
      r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
    } catch (e) {
      throw new AcPending(`请求失败 ${init.method ?? "GET"} ${url}: ${(e as Error).message}`);
    }
    const text = await r.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* 非 JSON 原样返回 */ }
    return { status: r.status, body: body as T, ms: performance.now() - t0, url };
  },
  get: <T = Json>(p: string, timeoutMs?: number) => api.req<T>(p, {}, timeoutMs),
  post: <T = Json>(p: string, b?: unknown, timeoutMs?: number) => api.req<T>(p, { method: "POST", body: b === undefined ? undefined : JSON.stringify(b) }, timeoutMs),
  patch: <T = Json>(p: string, b?: unknown) => api.req<T>(p, { method: "PATCH", body: JSON.stringify(b) }),
  del: <T = Json>(p: string) => api.req<T>(p, { method: "DELETE" }),
};

export async function health(): Promise<{ up: boolean; detail: string; body: Json | null }> {
  try {
    const r = await api.get("/health", 3000);
    if (r.status !== 200) return { up: false, detail: `GET /health → HTTP ${r.status}`, body: r.body };
    return { up: true, detail: r.body?.version ?? "ok", body: r.body };
  } catch (e) {
    return { up: false, detail: (e as Error).message, body: null };
  }
}

export interface AcOpts { needsServer?: boolean; note?: string }
type Fn = (h: Json) => Promise<void> | void;

/** 统一入口：处理 pending / pass / fail 与退出码。 */
export async function runAc(id: string, title: string, opts: AcOpts, fn: Fn): Promise<void> {
  const self = process.argv[1] ?? `test/smoke/${id}`;
  log(`=== ${id} ${title}${opts.note ? "  [" + opts.note + "]" : ""} ===`);
  log(`    cmd: node --import tsx ${self}`);
  if (opts.needsServer !== false) {
    const h = await health();
    if (!h.up) {
      log(`${id} PENDING: 服务未就绪（${BASE}/health → ${h.detail}）`);
      log(`    就绪后运行:  npx tsx apps/server/src/main.ts   # 后台+日志，监听 127.0.0.1:7317`);
      log(`                node --import tsx ${self}`);
      if (opts.note) log(`    前置说明: ${opts.note}`);
      return;
    }
    log(`    health: ${JSON.stringify(h.body)}`);
    try { await fn(h.body); } catch (e) {
      if (e instanceof AcPending) { log(`${id} PENDING: ${e.message}`); log(`    就绪/备好后重跑: node --import tsx ${self}`); return; }
      log(`${id} FAIL: ${(e as Error).message}`);
      if (!(e instanceof AcFailure)) log((e as Error).stack ?? "");
      process.exitCode = 1; return;
    }
    log(`${id} PASS`);
    return;
  }
  try { await fn(null); } catch (e) {
    if (e instanceof AcPending) { log(`${id} PENDING: ${e.message}`); return; }
    log(`${id} FAIL: ${(e as Error).message}`);
    if (!(e instanceof AcFailure)) log((e as Error).stack ?? "");
    process.exitCode = 1; return;
  }
  log(`${id} PASS`);
}

/** 轮询作业到终态；超过上限抛 AcPending（提示用后台跑并加大 AV_SMOKE_TIMEOUT_MS）。 */
export async function waitJob(jobId: number, totalMs = DEFAULT_TIMEOUT_MS, pollMs = 1500): Promise<Json> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const r = await api.get(`/jobs?limit=200`);
    const jobs: Json[] = Array.isArray(r.body?.jobs) ? r.body.jobs : [];
    const j = jobs.find((x) => Number(x.id) === Number(jobId));
    if (j && ["done", "failed", "cancelled", "abandoned"].includes(j.state)) {
      log(`    job ${jobId} → ${j.state} (attempts=${j.attempts})${j.error ? " error=" + j.error : ""}`);
      if (j.state !== "done") throw new AcFailure(`job ${jobId} 终态 ${j.state}: ${j.error ?? ""}`);
      return j;
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }
  throw new AcPending(`作业 ${jobId} 在 ${totalMs}ms 内未到终态；加大 AV_SMOKE_TIMEOUT_MS 并用后台跑：AV_SMOKE_TIMEOUT_MS=600000 node --import tsx <本脚本>`);
}

export async function itemsByIds(ids: number[]): Promise<Json[]> {
  const out: Json[] = [];
  for (const id of ids) {
    const r = await api.get(`/items/${id}`);
    if (r.status === 200) out.push(r.body);
  }
  return out;
}

export function writePendingHint(lines: string[]): void { for (const l of lines) log("    " + l); }

// ---- 最小合法 ZIP（store，无压缩）：给 AC7 等需要"真实可解析容器"的脚本用 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
export function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF]! ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
export function makeMinimalZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const en of entries) {
    const name = Buffer.from(en.name, "utf8");
    const crc = crc32(en.data), size = en.data.length;
    const lh = Buffer.alloc(30 + name.length);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    name.copy(lh, 30);
    locals.push(lh, en.data);
    const ch = Buffer.alloc(46 + name.length);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(size, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42); name.copy(ch, 46);
    centrals.push(ch);
    offset += lh.length + size;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}
