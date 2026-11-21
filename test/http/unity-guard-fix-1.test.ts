/**
 * 可靠性批次 1 / 修复轮 1：审查 P1/P2/P3 的回归。
 * - P1-1：Unity 连接错误（含 query token / 旧库 userinfo）对外与日志都必须脱敏。
 * - P3-8：边界对旧脏配置同样校验协议/凭据；allowRemote 不等于放行非法 URL。
 * - P2-5：PUT /api/settings 先校验全部入参再写库，400 不得部分落库。
 * - P2-6：unityMcpAllowRemote 可通过设置 API 组合提交，GET 回读（前端设置面板据此提供开关）。
 * - P1-2/P2-3/P2-4/P3-7：前端源码级防回退（工作台在详情之上；详情不再有死状态；dropped 提示两分支可见）。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { openTempDb, addRoot, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerRoutes } from "../../apps/server/src/http/routes";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";
import { redactUrlCredentials, unityMcpBoundary } from "../../apps/server/src/services/unity";

const originalFetch = globalThis.fetch;

let t: TempDb; let repo: Repo; let rootId: number; let dir: string;
beforeEach(() => { t = openTempDb(); repo = new Repo(t.db); rootId = addRoot(t.db, "/lib"); dir = mkdtempSync(join(tmpdir(), "av-guard-fix1-")); });
afterEach(() => { try { t.close(); } catch { /* ignore */ } rmSync(dir, { recursive: true, force: true }); });

const app = () => {
  const a = Fastify({ logger: false });
  registerRoutes(a as any, {
    repo, media: {} as any, booth: {} as any, runner: {} as any, log: () => {}, version: "test",
    dbPath: join(dir, "t.db"), dataDir: dir, pipeline: null, limits: resolveLimits({}),
  } as any);
  return a;
};

describe("P1-1: Unity 连接错误脱敏（query token / 旧库 userinfo）", () => {
  // G2/G5：该错误路径测试作用域封闭出站 fetch；默认候选 8080/14523 及任何 URL 一律失败，
  // 不触碰真实 Unity。guardCalls 记录实际被 Connect 调用的 URL；afterEach 恢复并断言。
  const realFetch = originalFetch;
  const guardCalls: string[] = [];
  beforeEach(() => {
    guardCalls.length = 0;
    globalThis.fetch = (async (input: any) => {
      const raw = input instanceof Request ? input.url : String(input);
      guardCalls.push(raw);
      throw new Error("test guard: outbound fetch blocked");
    }) as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    assert.equal(globalThis.fetch, realFetch, "fetch guard must be restored after the test");
  });

  test("回环地址带 ?token 保存后，/unity/status 的错误文本不回显 token", async () => {
    repo.setSetting("unity_mcp_url", "http://127.0.0.1:9/mcp?token=SECRET");
    const res = await app().inject({ method: "GET", url: "/api/unity/status" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false, "测试环境不该真的有 Unity 在 9 端口");
    assert.ok(!res.body.includes("SECRET"), "连接错误不得回显 query token：" + res.body);
    assert.ok(!String(body.error ?? "").includes("token="), "错误文本不得保留查询串");
    assert.ok(String(body.error ?? "").includes("127.0.0.1"), "脱敏后仍要能看出试过哪个端点（排障）");
    assert.notEqual(globalThis.fetch, realFetch, "guard must be installed during the test");
    assert.ok(guardCalls.some((u) => u.includes("127.0.0.1:9")), "Connect must call the guard for the saved endpoint");
    assert.ok(guardCalls.some((u) => u.includes("127.0.0.1:8080")), "Connect must call the guard for default 8080");
    assert.ok(guardCalls.some((u) => u.includes("127.0.0.1:14523")), "Connect must call the guard for default 14523");
  });

  test("旧库脏值（userinfo）进不了可连接端点，status 也不回显凭据", async () => {
    repo.setSetting("unity_mcp_url", "http://user:pass@127.0.0.1:9/mcp?token=SECRET");
    const res = await app().inject({ method: "GET", url: "/api/unity/status" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(!res.body.includes("user:pass"), "不得回显旧库 userinfo");
    assert.ok(!res.body.includes("SECRET"), "不得回显旧库 query token");
    assert.ok(Number(body.dropped) >= 1, "带凭据的脏值必须被边界丢弃并计数");
    assert.ok(body.candidates.every((c: string) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(c)), "候选只能是默认回环：" + JSON.stringify(body.candidates));
  });

  test("边界对旧脏配置也校验协议/凭据；allowRemote=1 不放行非法 URL", () => {
    const settings: Record<string, string> = { unity_mcp_url: "file:///etc/passwd", unity_mcp_allow_remote: "1" };
    const b = unityMcpBoundary({ getSetting: (k: string) => settings[k] ?? "" } as any);
    assert.ok(!b.urls.includes("file:///etc/passwd"), "allowRemote 也不得放行 file://");
    assert.ok(b.dropped.length >= 1, "非法协议应计入 dropped");

    settings.unity_mcp_url = "http://user:pass@10.0.0.5:8080/mcp";
    const b2 = unityMcpBoundary({ getSetting: (k: string) => settings[k] ?? "" } as any);
    assert.ok(!b2.urls.some((u) => u.includes("user:pass")), "allowRemote 也不得放行内嵌凭据");
    assert.ok(!b2.urls.some((u) => u.includes("10.0.0.5")), "allowRemote=0 时远端仍被丢弃");
  });

  test("redactUrlCredentials：错误文本里的 URL 凭据/查询串被剥离", () => {
    const raw = "连不上 Unity MCP（http://user:pass@127.0.0.1:9/mcp?token=SECRET: fetch failed）";
    const safe = redactUrlCredentials(raw);
    assert.ok(!safe.includes("user:pass"), safe);
    assert.ok(!safe.includes("SECRET"), safe);
    assert.ok(safe.includes("127.0.0.1"), safe);
    assert.equal(redactUrlCredentials("没有 URL 的普通错误"), "没有 URL 的普通错误");
  });
});

test("G5 negative: own fake fetch fails before any network", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("negative: no network"); }) as typeof globalThis.fetch;
  try {
    await assert.rejects(fetch("http://127.0.0.1:8080/mcp"), /negative: no network/);
  } finally {
    globalThis.fetch = saved;
  }
  assert.equal(globalThis.fetch, saved, "negative fake fetch must be restored");
});

describe("P2-5: PUT /api/settings 先校验后写（400 不部分落库）", () => {
  test("downloadRoot 与非法 unityMcpUrl 同批提交：400 且两者都不写", async () => {
    const newDir = join(dir, "downloads-new");
    const res = await app().inject({ method: "PUT", url: "/api/settings", payload: { downloadRoot: newDir, unityMcpUrl: "ftp://127.0.0.1/mcp" } });
    assert.equal(res.statusCode, 400);
    assert.equal((repo.getSetting("download_root") ?? ""), "", "400 时 download_root 不得落库");
    assert.equal(existsSync(newDir), false, "400 时不得创建下载目录");
    assert.equal((repo.getSetting("unity_mcp_url") ?? ""), "", "非法 URL 不得落库");
  });

  test("合法 unityMcpUrl 与非法 updateRepo 同批：400 且 URL 不落库", async () => {
    const res = await app().inject({ method: "PUT", url: "/api/settings", payload: { unityMcpUrl: "http://127.0.0.1:14523/mcp", updateRepo: "not a slug" } });
    assert.equal(res.statusCode, 400);
    assert.equal((repo.getSetting("unity_mcp_url") ?? ""), "", "同批有非法项时合法项也先不落库");
  });

  test("全部合法时一次写入（downloadRoot + url）", async () => {
    const newDir = join(dir, "downloads-ok");
    const res = await app().inject({ method: "PUT", url: "/api/settings", payload: { downloadRoot: newDir, unityMcpUrl: "http://127.0.0.1:14523/mcp" } });
    assert.equal(res.statusCode, 200);
    assert.equal(repo.getSetting("download_root"), newDir);
    assert.equal(existsSync(newDir), true);
    assert.equal(repo.getSetting("unity_mcp_url"), "http://127.0.0.1:14523/mcp");
  });
});

describe("P2-6: unityMcpAllowRemote 走既有设置 API（默认关闭）", () => {
  test("同一个 PUT 里允许远端并保存地址；GET 回读开关", async () => {
    let res = await app().inject({ method: "GET", url: "/api/settings" });
    assert.equal(JSON.parse(res.body).unityMcpAllowRemote, false, "默认关闭");

    res = await app().inject({ method: "PUT", url: "/api/settings", payload: { unityMcpUrl: "http://10.0.0.5:8080/mcp", unityMcpAllowRemote: true } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(repo.getSetting("unity_mcp_allow_remote"), "1");
    assert.equal(repo.getSetting("unity_mcp_url"), "http://10.0.0.5:8080/mcp");

    res = await app().inject({ method: "GET", url: "/api/settings" });
    const s = JSON.parse(res.body);
    assert.equal(s.unityMcpAllowRemote, true);
    assert.equal(s.unityMcpUrl, "http://10.0.0.5:8080/mcp");
  });

  test("关掉开关时清掉已存的远端地址；内嵌凭据仍拒", async () => {
    repo.setSetting("unity_mcp_allow_remote", "1");
    repo.setSetting("unity_mcp_url", "http://10.0.0.5:8080/mcp");
    let res = await app().inject({ method: "PUT", url: "/api/settings", payload: { unityMcpAllowRemote: false } });
    assert.equal(res.statusCode, 200);
    assert.equal(repo.getSetting("unity_mcp_url"), "", "关网关必须同时清掉远程地址");

    res = await app().inject({ method: "PUT", url: "/api/settings", payload: { unityMcpUrl: "http://user:pass@127.0.0.1:8080/mcp" } });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error.code, "URL_CREDENTIALS");
    assert.equal(repo.getSetting("unity_mcp_url"), "", "带凭据的地址不得落库");
  });
});

describe("P1-2/P2-3/P2-4/P3-7: 前端防回退（源码级）", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL("../../" + rel, import.meta.url)), "utf8");

  test("工作台打开时隐藏详情遮罩，两个面板的键互不冲突", () => {
    const src = read("apps/web/src/App.tsx");
    assert.match(src, /<ItemDetail\s+key=\{"item-detail:"\s*\+\s*selectedItemId\}\s+hidden=\{workbenchOpen\}/);
    assert.match(src, /<AvatarWorkbench\s+key=\{"workbench:"\s*\+/);
    assert.match(src, /<AvatarWorkbench[^>]*focus=/, "工作台必须接收详情页传来的选包上下文");
    assert.match(read("apps/web/src/components/ItemDetail.tsx"), /className: "backdrop item-detail-backdrop", hidden: props\.hidden/);
    assert.match(read("apps/web/src/styles.css"), /\.backdrop\[hidden\]\s*\{\s*display:\s*none/);
  });

  test("详情页不再有 unityErrors 死状态；选包语义与按钮一致（不再 disabled 误导）", () => {
    const src = read("apps/web/src/components/ItemDetail.tsx");
    assert.equal(src.includes("unityErrors"), false, "unityErrors 的写入方已删，死状态必须清除");
    assert.ok(!/disabled=\{!unityPicked\.size\}/.test(src), "勾选是带入清单的上下文，不再是打开工作台的前置条件");
    assert.match(src, /onOpenWorkbench\?\.\(\{\s*itemId,/, "详情页必须把条目传给工作台");
  });

  test("dropped 提示在「已连接」与「没连上」两个分支都可见", () => {
    const src = read("apps/web/src/components/AvatarWorkbench.tsx");
    const dropped = src.indexOf("!!editor?.dropped");
    const offline = src.indexOf('page !== "result" && !matchesEditor');
    assert.ok(dropped > 0 && offline > 0);
    assert.ok(dropped > offline, "dropped 提示必须移到连接分支之外（排障时也要看得到）");
  });
});
