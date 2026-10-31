/**
 * Task 3（可靠性批次）：有界流式 BOOTH 下载的离线回归。
 * 只用 mock fetch + 合成 ReadableStream + 临时目录；不联网、不触真实 BOOTH。
 *
 * 指标（定义与已知正反例）：
 *  - "实际字节硬上限" = 从 res.body 读到的累计字节数，== cap 通过、> cap 以 TOO_LARGE 拒绝；不采信 Content-Length。
 *    正例：exact-limit 1000/1000 通过；反例：声明 10 字节实发 2000 必须拒绝（只看头部会误判通过）。
 *  - "有界内存" = 源码不再整包 arrayBuffer/text/Buffer 缓冲；HTML 登录态用有界前缀判定。
 *  - "全覆盖 deadline" = 从首个请求到 body 落盘完成共享一个截止时间，逐跳不重置；stall 必须被主动取消。
 *  - "原子非覆盖发布" = 竞争者先建同名文件时既不能覆盖它，也不能留下未发布的临时文件。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadBoothFile,
  DEFAULT_DOWNLOAD_MAX_BYTES,
  DEFAULT_DOWNLOAD_DEADLINE_MS,
} from "../src/services/download";

const cjsFs = createRequire(import.meta.url)("node:fs");
const URL_A = "https://booth.pm/downloadables/111?variation_id=2";
const URL_HOP = "https://s6.booth.pm/dl/222/file.zip";

let dir = "";
let fetchCalls: string[] = [];
let lastSignal: AbortSignal | null = null;
let realFetch: typeof globalThis.fetch;

type FetchImpl = (url: string, init: any) => Promise<Response>;

function mockFetch(impl: FetchImpl): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    fetchCalls.push(String(input));
    lastSignal = (init?.signal as AbortSignal) ?? null;
    return impl(String(input), init);
  }) as any;
}

function bytes(n: number, seed = 7): Buffer {
  const b = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

function respond(chunks: Buffer[], init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const queue = chunks.slice();
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      const next = queue.shift();
      if (next) c.enqueue(new Uint8Array(next));
      else c.close();
    },
  });
  return new Response(body, { status: init.status ?? 200, headers: init.headers });
}

function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

/** 永不产出、永不结束的 body：模拟 stall。 */
function stalled(): Response {
  const body = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } });
  return new Response(body, { status: 200 });
}

async function rejection(p: Promise<unknown>): Promise<any> {
  let ok = true;
  let err: any = null;
  try { await p; } catch (e) { ok = false; err = e; }
  assert.equal(ok, false, "预期拒绝，实际成功");
  return err;
}

const listing = (): string[] => readdirSync(dir).sort();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "av-dl-task3-"));
  fetchCalls = [];
  lastSignal = null;
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("默认值：有限正数与可验证的边界", () => {
  test("默认 cap / deadline 是有限正数（文档化的运维默认）", () => {
    assert.ok(Number.isSafeInteger(DEFAULT_DOWNLOAD_MAX_BYTES));
    assert.ok(DEFAULT_DOWNLOAD_MAX_BYTES > 0);
    assert.ok(Number.isFinite(DEFAULT_DOWNLOAD_DEADLINE_MS));
    assert.ok(DEFAULT_DOWNLOAD_DEADLINE_MS >= 10_000, "默认 deadline 不应短到误杀正常大文件");
    assert.ok(DEFAULT_DOWNLOAD_DEADLINE_MS <= 60 * 60 * 1000);
  });
});

describe("正常路径：多块二进制 + 精确字节", () => {
  test("逐块写入临时文件后发布，字节与内容精确、无 tmp 残留", { timeout: 5000 }, async () => {
    const parts = [bytes(1000, 1), bytes(65536, 2), bytes(1234, 3)];
    const total = parts.reduce((a, b) => a + b.length, 0);
    mockFetch(() => respond(parts, { headers: { "content-type": "application/zip" } }));
    const r = await downloadBoothFile({ dlUrl: URL_A, destDir: dir, fileName: "pkg.zip", maxBytes: 1024 * 1024, timeoutMs: 5000 });
    assert.equal(r.bytes, total);
    assert.equal(r.fileName, "pkg.zip");
    assert.equal(r.finalUrl, URL_A);
    assert.equal(statSync(r.path).size, total);
    assert.deepEqual(readFileSync(r.path), Buffer.concat(parts));
    assert.deepEqual(listing(), ["pkg.zip"], "临时文件必须已清理");
  });

  test("exact-limit：实际字节 == cap 通过（边界正例）", { timeout: 5000 }, async () => {
    const body = bytes(1000, 5);
    mockFetch(() => respond([body]));
    const r = await downloadBoothFile({ dlUrl: URL_A, destDir: dir, fileName: "exact.zip", maxBytes: 1000, timeoutMs: 5000 });
    assert.equal(r.bytes, 1000);
    assert.deepEqual(readFileSync(r.path), body);
    assert.deepEqual(listing(), ["exact.zip"]);
  });
});

describe("实际字节硬上限：不信 Content-Length", () => {
  test("无 Content-Length 且实发超 cap：TOO_LARGE、清理临时、无成品", { timeout: 5000 }, async () => {
    mockFetch(() => respond([bytes(400, 1), bytes(400, 2), bytes(400, 3), bytes(400, 4), bytes(400, 5)]));
    const e = await rejection(downloadBoothFile({ dlUrl: URL_A, destDir: dir, fileName: "big.zip", maxBytes: 1000, timeoutMs: 5000 }));
    assert.equal(e.code, "TOO_LARGE");
    assert.deepEqual(listing(), [], "超限不得留下 tmp 或半成品");
  });

  test("伪小 Content-Length（10）不能掩盖 2000 实际字节：仍然拒绝", { timeout: 5000 }, async () => {
    mockFetch(() => respond([bytes(1000, 1), bytes(1000, 2)], { headers: { "content-length": "10" } }));
    const e = await rejection(downloadBoothFile({ dlUrl: URL_A, destDir: dir, fileName: "lie.zip", maxBytes: 1000, timeoutMs: 5000 }));
    assert.equal(e.code, "TOO_LARGE");
    assert.deepEqual(listing(), []);
  });

  test("非法 cap/deadline 覆盖值：先拒绝且不发请求", { timeout: 5000 }, async () => {
    mockFetch(() => respond([bytes(10)]));
    for (const bad of [0, -1, NaN, Infinity, 0.5]) {
      const e1 = await rejection(downloadBoothFile({ dlUrl: URL_A, destDir: dir, fileName: "x.zip", maxBytes: bad as any }));
      assert.equal(e1.code, "INVALID_INPUT", "maxBytes=" + String(bad) + " 必须拒绝");
      const e2 = await rejection(downloadBoothFile({ dlUrl: URL_A, destDir: dir, fileName: "x.zip", timeoutMs: bad as any }));
      assert.equal(e2.code, "INVALID_INPUT", "timeoutMs=" + String(bad) + " 必须拒绝");
    }
    assert.equal(fetchCalls.length, 0, "参数非法时不得发起网络请求");
    assert.deepEqual(listing(), []);
  });
});

describe("中断与 stall：取消 + 清理", () => {
  test("流中途报错：拒绝、关闭句柄、删除 tmp、不留半成品", { timeout: 5000 }, async () => {
    mockFetch(() => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(bytes(256, 1)));
          c.error(new Error("upstream-reset"));
        },
      });
      return new Response(body, { status: 200 });
    });
    const e = await rejection(downloadBoothFile({ dlUrl: URL_A, destDir: dir, fileName: "half.zip", maxBytes: 1024 * 1024, timeoutMs: 5000 }));
    assert.equal(e.code, "UPSTREAM_ERROR");
    assert.deepEqual(listing(), [], "断流后不得留下 tmp 或半成品");
  });

  test("stall 的 body 被有限 deadline 主动取消（不无限挂起）", { timeout: 5000 }, async () => {
    mockFetch(() => stalled());
    const t0 = Date.now();
    const e = await rejection(downloadBoothFile({ dlUrl: URL_A, destDir: dir, fileName: "stall.zip", maxBytes: 1024 * 1024, timeoutMs: 120 }));
    const elapsed = Date.now() - t0;
    assert.equal(e.code, "UPSTREAM_TIMEOUT");
    assert.ok(elapsed >= 60, "应真的等过一段有限时间，而不是立刻失败: " + elapsed);
    assert.ok(elapsed < 3000, "必须在有限时间内放弃: " + elapsed);
    assert.deepEqual(listing(), []);
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(lastSignal?.aborted === true, "stall 时 AbortSignal 必须被触发（取消底层响应）");
  });

  test("deadline 跨重定向累计：不每跳重置（否则会等到 hop 超时之和）", { timeout: 5000 }, async () => {
    mockFetch(async (url) => {
      if (url === URL_A) {
        await new Promise((r) => setTimeout(r, 200));
        return redirectTo(URL_HOP);
      }
      return stalled();
    });
    const t0 = Date.now();
    const e = await rejection(downloadBoothFile({ dlUrl: URL_A, destDir: dir, fileName: "rd.zip", maxBytes: 1024 * 1024, timeoutMs: 250 }));
    const elapsed = Date.now() - t0;
    assert.equal(e.code, "UPSTREAM_TIMEOUT");
    assert.ok(elapsed < 480, "总耗时 " + elapsed + "ms 说明 deadline 不共享（每跳 250ms 会到 450ms+）");
    assert.deepEqual(listing(), []);
  });
});

describe("登录/HTML 诊断：有界前缀，不整包缓冲", () => {
  test("HTML 登录页判为 LOGIN_REQUIRED 且不落盘", { timeout: 5000 }, async () => {
    mockFetch(() => respond([
      Buffer.from("<!DOCTYPE html><html><body>Sign in to BOOTH</body></html>", "latin1"),
      bytes(2048, 9),
    ], { headers: { "content-type": "text/html; charset=utf-8" } }));
    const e = await rejection(downloadBoothFile({ dlUrl: URL_A, destDir: dir, fileName: "login.html", maxBytes: 1024 * 1024, timeoutMs: 5000 }));
    assert.equal(e.code, "LOGIN_REQUIRED");
    assert.deepEqual(listing(), []);
  });

  test("超大 HTML 仍在有界前缀内判定（不会读满 4MB 后才报超限）", { timeout: 5000 }, async () => {
    let served = 0;
    mockFetch(() => {
      const queue: Buffer[] = [Buffer.from("<html><body>login</body>", "latin1")];
      for (let i = 0; i < 64; i++) queue.push(Buffer.alloc(65536, 0x78));
      const body = new ReadableStream<Uint8Array>({
        pull(c) { const n = queue.shift(); if (!n) { c.close(); return; } served += n.length; c.enqueue(new Uint8Array(n)); },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    });
    const e = await rejection(downloadBoothFile({ dlUrl: URL_A, destDir: dir, fileName: "huge.html", maxBytes: 1024 * 1024, timeoutMs: 5000 }));
    assert.equal(e.code, "LOGIN_REQUIRED", "HTML 判定必须发生在超限前（有界前缀）");
    assert.ok(served < 4 * 1024 * 1024, "不应把整包读完才判定 HTML: " + served);
    assert.deepEqual(listing(), []);
  });
});

describe("重定向：逐跳白名单与计数", () => {
  test("允许的 BOOTH 子域 302 成功跟随，finalUrl 为最后一跳", { timeout: 5000 }, async () => {
    const body = bytes(777, 3);
    mockFetch((url) => (url === URL_A ? redirectTo(URL_HOP) : respond([body])));
    const r = await downloadBoothFile({ dlUrl: URL_A, destDir: dir, fileName: "hop.zip", maxBytes: 1024 * 1024, timeoutMs: 5000 });
    assert.equal(r.finalUrl, URL_HOP);
    assert.equal(r.bytes, 777);
    assert.deepEqual(readFileSync(r.path), body);
    assert.equal(fetchCalls.length, 2);
    assert.deepEqual(fetchCalls, [URL_A, URL_HOP]);
  });

  test("重定向到非 BOOTH 域：拒绝且绝不对该域发请求（无资源泄漏）", { timeout: 5000 }, async () => {
    mockFetch(() => redirectTo("https://evil.example/steal.zip"));
    const e = await rejection(downloadBoothFile({ dlUrl: URL_A, destDir: dir, fileName: "evil.zip", maxBytes: 1024 * 1024, timeoutMs: 5000 }));
    assert.equal(e.code, "INVALID_INPUT");
    assert.equal(fetchCalls.length, 1, "被拒绝的跳转目标不得被请求");
    assert.match(e.message, /evil\.example/);
    assert.deepEqual(listing(), []);
  });

  test("重定向次数上限：超过 maxHops 以 UPSTREAM_ERROR 结束且清理", { timeout: 5000 }, async () => {
    mockFetch((url) => redirectTo(url + "?n=" + fetchCalls.length));
    const e = await rejection(downloadBoothFile({ dlUrl: URL_A, destDir: dir, fileName: "loop.zip", maxHops: 3, maxBytes: 1024 * 1024, timeoutMs: 5000 }));
    assert.equal(e.code, "UPSTREAM_ERROR");
    assert.ok(fetchCalls.length <= 4, "不得无限跟随: " + fetchCalls.length);
    assert.deepEqual(listing(), []);
  });
});

describe("发布：既有文件保留 + 竞争不覆盖", () => {
  test("同名既有文件保留，新内容改名为带序号的名字", { timeout: 5000 }, async () => {
    writeFileSync(join(dir, "pkg.zip"), Buffer.from("KEEP-OLD", "utf8"));
    const body = bytes(500, 4);
    mockFetch(() => respond([body]));
    const r = await downloadBoothFile({ dlUrl: URL_A, destDir: dir, fileName: "pkg.zip", maxBytes: 1024 * 1024, timeoutMs: 5000 });
    assert.equal(r.fileName, "pkg (1).zip");
    assert.deepEqual(readFileSync(join(dir, "pkg.zip")), Buffer.from("KEEP-OLD", "utf8"));
    assert.deepEqual(readFileSync(r.path), body);
    assert.deepEqual(listing(), ["pkg (1).zip", "pkg.zip"]);
  });

  test("竞争者在发布窗口内先建成同名文件：不得覆盖赢家（check-then-rename 竞态）", { timeout: 5000 }, async () => {
    const body = bytes(640, 6);
    mockFetch(() => respond([body]));
    const original = cjsFs.linkSync;
    let hijacked = 0;
    // 模拟"检查通过之后、发布之前"另一个写者赢得同名文件。
    (cjsFs as any).linkSync = (from: string, to: string, ...rest: any[]) => {
      if (hijacked++ === 0) writeFileSync(to, Buffer.from("WINNER", "utf8"));
      return original(from, to, ...rest);
    };
    let r: any;
    try {
      r = await downloadBoothFile({ dlUrl: URL_A, destDir: dir, fileName: "race.zip", maxBytes: 1024 * 1024, timeoutMs: 5000 });
    } finally {
      (cjsFs as any).linkSync = original;
    }
    assert.ok(hijacked >= 1, "必须走独占发布原语（linkSync）；未能拦截说明发布不是独占的");
    assert.ok(!r.path.endsWith("race.zip") || !existsSync(join(dir, "race.zip")), "不得声称发布了竞争者的名字");
    assert.deepEqual(readFileSync(join(dir, "race.zip")), Buffer.from("WINNER", "utf8"), "赢家文件必须原样保留");
    assert.notEqual(r.path, join(dir, "race.zip"), "必须改用新的不冲突名字");
    assert.deepEqual(readFileSync(r.path), body, "自己的成品内容必须完整");
    assert.equal(listing().filter((f) => f.endsWith(".tmp")).length, 0, "不得留下孤儿 tmp");
  });

  test("平台不支持硬链接（EPERM）时：安全非覆盖回退，绝不覆盖既有文件", { timeout: 5000 }, async () => {
    writeFileSync(join(dir, "pkg.zip"), Buffer.from("KEEP-OLD", "utf8"));
    mockFetch(() => respond([bytes(300, 8)]));
    const original = cjsFs.linkSync;
    (cjsFs as any).linkSync = () => { const e: any = new Error("EPERM: operation not permitted, link"); e.code = "EPERM"; throw e; };
    let r: any;
    try {
      r = await downloadBoothFile({ dlUrl: URL_A, destDir: dir, fileName: "pkg.zip", maxBytes: 1024 * 1024, timeoutMs: 5000 });
    } finally {
      (cjsFs as any).linkSync = original;
    }
    assert.deepEqual(readFileSync(join(dir, "pkg.zip")), Buffer.from("KEEP-OLD", "utf8"), "回退路径同样不得覆盖既有文件");
    assert.equal(r.fileName, "pkg (1).zip");
    assert.deepEqual(readFileSync(r.path), bytes(300, 8));
    assert.equal(listing().filter((f) => f.endsWith(".tmp")).length, 0);
  });
});

describe("源码级防回退：这条下载路径不再整包缓冲", () => {
  test("download.ts 不含 arrayBuffer/text/整包 Buffer 缓冲，且使用流式写入与独占发布", () => {
    const src = readFileSync(new URL("../src/services/download.ts", import.meta.url), "utf8");
    assert.ok(!/arrayBuffer\s*\(/.test(src), "不得使用 res.arrayBuffer() 整包缓冲");
    assert.ok(!/Buffer\.from\s*\(\s*await/.test(src), "不得把整个响应体读成 Buffer");
    assert.ok(!/\.text\s*\(\s*\)/.test(src), "不得对响应体做 .text() 整包转换");
    assert.ok(/getReader\s*\(/.test(src), "必须走 ReadableStream reader 逐块读");
    assert.ok(/createWriteStream/.test(src), "必须走流式文件写入");
    assert.ok(/linkSync/.test(src), "发布必须用独占原语（link 语义），不许裸 rename 覆盖");
  });
});
