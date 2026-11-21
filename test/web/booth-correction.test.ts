/**
 * BOOTH 更正（task-71；frozen-interface-B1.md §两个新端点/§界面）。
 *
 * ① wrapper 闭网 fetch stub：method/path/body 与 409 details 透传；
 * ② 真实 handler 工厂：取消 0 请求 / 未预览不确认 / 未勾选不确认 / 冲突不确认 /
 *    成功 body 精确（expected 旧 binding + target.itemId）+ reload/onChanged / STALE 清预览；
 * ③ 静态补充：ItemDetail 入口与 section 渲染（**非 DOM**，真实 Chrome 归后续门）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiError, boothCorrectionConfirm, boothCorrectionPreview } from "../../apps/web/src/api";
import type { BoothCorrectionPreview } from "../../apps/web/src/api";
import {
  boothCorrectionConflictOf, createBoothCorrectionHandlers, type BoothCorrectionHandlerDeps,
} from "../../apps/web/src/components/BoothCorrectionSection";

// ---------------- fixtures ----------------

function binding(over: Partial<BoothCorrectionPreview["current"]> = {}): BoothCorrectionPreview["current"] {
  return {
    sourceSite: "booth", sourceItemId: "111",
    sourceUrl: "https://booth.pm/ja/items/111", canonicalUrl: "https://booth.pm/ja/items/111",
    sourceGone: false, ...over,
  };
}

function preview(over: Partial<BoothCorrectionPreview> = {}): BoothCorrectionPreview {
  return {
    itemId: 7,
    current: binding(),
    target: {
      itemId: "222", url: "https://booth.pm/ja/items/222", canonicalUrl: "https://booth.pm/ja/items/222",
      title: "新商品", shop: { name: "店", subdomain: "shop" }, priceText: "¥100", priceYen: 100,
      publishedAt: null, isAdult: false, category: { name: "衣装", parent: null }, tags: ["a"],
      imageCount: 3, fileCount: 1,
    },
    willChange: ["sourceItemId"], willPreserve: ["title"], conflict: null,
    ...over,
  };
}

// ---------------- ① wrapper（闭网） ----------------

interface StubCall { url: string; method: string; body: unknown }

function stubFetch(responder: (call: StubCall) => Response): { calls: StubCall[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: StubCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call: StubCall = { url, method, body };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("preview/confirm 的 method/path/body 精确；confirm 只带固定 6 字段", async () => {
  const stub = stubFetch((call) => {
    if (call.url.endsWith("/preview")) return json(preview());
    return json({ changed: true, itemId: 7, previousBinding: binding(), currentBinding: binding({ sourceItemId: "222" }), item: {} });
  });
  try {
    await boothCorrectionPreview(7, "https://booth.pm/ja/items/222");
    assert.deepEqual(stub.calls[0], {
      url: "/api/items/7/booth-correction/preview", method: "POST",
      body: { url: "https://booth.pm/ja/items/222" },
    });

    await boothCorrectionConfirm(7, {
      url: "https://booth.pm/ja/items/222",
      expectedSourceSite: "booth", expectedSourceItemId: "111", expectedSourceUrl: "https://booth.pm/ja/items/111",
      expectedTargetItemId: "222", confirm: true,
    });
    assert.equal(stub.calls[1].url, "/api/items/7/booth-correction/confirm");
    assert.equal(stub.calls[1].method, "POST");
    assert.deepEqual(Object.keys(stub.calls[1].body as Record<string, unknown>).sort(), [
      "confirm", "expectedSourceItemId", "expectedSourceSite", "expectedSourceUrl", "expectedTargetItemId", "url",
    ]);
  } finally { stub.restore(); }
});

test("409 details 透传：OCCUPIED 带 conflictItemId/title，STALE 可识别", async () => {
  const occupied = stubFetch(() => json({
    error: { code: "CONFLICT", message: "目标商品已被占用", details: { code: "BOOTH_CORRECTION_OCCUPIED", conflictItemId: 9, title: "占用条目" } },
  }, 409));
  try {
    await assert.rejects(boothCorrectionConfirm(7, {
      url: "u", expectedSourceSite: "booth", expectedSourceItemId: "111", expectedSourceUrl: "u0",
      expectedTargetItemId: "222", confirm: true,
    }), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 409);
      assert.deepEqual(boothCorrectionConflictOf(err), { code: "BOOTH_CORRECTION_OCCUPIED", conflictItemId: 9, title: "占用条目" });
      return true;
    });
  } finally { occupied.restore(); }

  const stale = stubFetch(() => json({
    error: { code: "CONFLICT", message: "绑定已变化", details: { code: "BOOTH_CORRECTION_STALE" } },
  }, 409));
  try {
    await assert.rejects(boothCorrectionPreview(7, "u"), (err: unknown) => {
      assert.deepEqual(boothCorrectionConflictOf(err), { code: "BOOTH_CORRECTION_STALE" });
      return true;
    });
  } finally { stale.restore(); }
});

// ---------------- ② 真实 handler 工厂 ----------------

interface Harness {
  calls: string[];
  state: Record<string, unknown>;
  handlers: ReturnType<typeof createBoothCorrectionHandlers>;
}

function harness(over: {
  url?: string;
  preview?: BoothCorrectionPreview | null;
  confirmed?: boolean;
  busy?: string;
  apiOverrides?: Partial<BoothCorrectionHandlerDeps["api"]>;
} = {}): Harness {
  const calls: string[] = [];
  const state: Record<string, unknown> = {
    url: over.url ?? "https://booth.pm/ja/items/222",
    preview: over.preview === undefined ? preview() : over.preview,
    confirmed: over.confirmed ?? false,
    busy: over.busy ?? "",
  };
  const deps: BoothCorrectionHandlerDeps = {
    api: {
      preview: (id, url) => { calls.push("api:preview:" + id + ":" + url); return Promise.resolve(preview()); },
      confirm: (id, body) => {
        calls.push("api:confirm:" + id + ":" + JSON.stringify(body));
        return Promise.resolve({ changed: true, itemId: id, previousBinding: binding(), currentBinding: binding({ sourceItemId: "222" }), item: {} as never });
      },
    },
    itemId: 7,
    getUrl: () => String(state.url),
    getPreview: () => state.preview as BoothCorrectionPreview | null,
    getConfirmed: () => Boolean(state.confirmed),
    // 同步忙碌镜像：setBusy 立即写 state，getBusy 立刻可读（与真实 ref 语义一致）。
    getBusy: () => String(state.busy ?? ""),
    setPreview: (p) => { state.preview = p; calls.push("setPreview:" + (p ? p.target.itemId : "null")); },
    setConfirmed: (v) => { state.confirmed = v; calls.push("setConfirmed:" + String(v)); },
    setError: (e) => { state.error = e; calls.push("setError:" + e); },
    setBusy: (b) => { state.busy = b; calls.push("setBusy:" + b); },
    onToast: (k, t) => calls.push("toast:" + k + ":" + t),
    describeError: (e) => "ERR:" + String((e as Error)?.message ?? e),
    reload: () => calls.push("reload"),
    onChanged: () => calls.push("onChanged"),
  };
  if (over.apiOverrides) deps.api = { ...deps.api, ...over.apiOverrides };
  return { calls, state, handlers: createBoothCorrectionHandlers(deps) };
}

test("preview：空 URL 不请求；成功写预览并清掉确认勾选", async () => {
  const empty = harness({ url: "   " });
  await empty.handlers.preview();
  assert.equal(empty.calls.some((c) => c.startsWith("api:preview:")), false, "空 URL 不得请求");
  assert.ok(empty.calls.some((c) => c.startsWith("toast:bad:")), "空 URL 必须提示");

  const h = harness({ confirmed: true });
  await h.handlers.preview();
  assert.deepEqual(h.calls.filter((c) => c.startsWith("api:preview:")), ["api:preview:7:https://booth.pm/ja/items/222"]);
  assert.ok(h.calls.includes("setPreview:222"));
  assert.ok(h.calls.includes("setConfirmed:false"), "新预览必须清掉旧勾选");
});

test("confirm 门控：未预览/未勾选/预览冲突都不发请求", async () => {
  const noPreview = harness({ preview: null });
  await noPreview.handlers.confirm();
  assert.equal(noPreview.calls.some((c) => c.startsWith("api:confirm:")), false, "未预览不得确认");

  const unchecked = harness({ confirmed: false });
  await unchecked.handlers.confirm();
  assert.equal(unchecked.calls.some((c) => c.startsWith("api:confirm:")), false, "未勾选不得确认");
  assert.ok(unchecked.calls.some((c) => c.startsWith("toast:bad:")), "必须提示先勾选");

  const conflict = harness({ confirmed: true, preview: preview({ conflict: { itemId: 9, title: "占用条目" } }) });
  await conflict.handlers.confirm();
  assert.equal(conflict.calls.some((c) => c.startsWith("api:confirm:")), false, "冲突时不得确认");
  assert.ok(conflict.calls.some((c) => c.startsWith("toast:bad:") && c.includes("#9")), "必须显示占用 #id");
});

test("confirm 成功：body 用预览里的旧 binding + target.itemId；成功后 reload+onChanged", async () => {
  const h = harness({ confirmed: true });
  await h.handlers.confirm();
  const sent = h.calls.filter((c) => c.startsWith("api:confirm:"));
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0].slice("api:confirm:7:".length)), {
    url: "https://booth.pm/ja/items/222",
    expectedSourceSite: "booth",
    expectedSourceItemId: "111",
    expectedSourceUrl: "https://booth.pm/ja/items/111",
    expectedTargetItemId: "222",
    confirm: true,
  });
  assert.ok(h.calls.includes("reload"), "成功后必须重载详情");
  assert.ok(h.calls.includes("onChanged"), "成功后必须通知父刷新");
  assert.ok(h.calls.includes("setPreview:null"), "成功后清掉预览");
  assert.ok(h.calls.some((c) => c.startsWith("toast:ok:")), "成功要有 ok toast");
});

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test("忙碌门：已 busy 时 preview/confirm 都零请求", async () => {
  const h = harness({ busy: "预览", confirmed: true });
  await h.handlers.preview();
  await h.handlers.confirm();
  assert.equal(h.calls.some((c) => c.startsWith("api:")), false, "已 busy 不得发任何请求");
});

test("忙碌门：同 tick 第二次调用被挡，首个完成后允许新请求（deferred，无 sleep）", async () => {
  const d = deferred<BoothCorrectionPreview>();
  let sent = 0;
  const h = harness({ apiOverrides: { preview: () => { sent += 1; return d.promise; } } });
  const first = h.handlers.preview();
  const second = h.handlers.preview();   // 同 tick，首个 Promise 尚未完成
  assert.equal(sent, 1, "同 tick 第二次不得再发请求（不能只靠旧 state 闭包）");
  d.resolve(preview());
  await Promise.all([first, second]);
  assert.equal(h.state.busy, "", "首个完成后必须释放忙碌门");

  const third = h.handlers.preview();
  await third;
  assert.equal(sent, 2, "释放后允许新请求");
});

test("取消：0 请求、清预览/勾选/错误", async () => {
  const h = harness({ confirmed: true });
  h.handlers.cancel();
  assert.equal(h.calls.some((c) => c.startsWith("api:")), false, "取消不得发任何请求");
  assert.ok(h.calls.includes("setPreview:null"));
  assert.ok(h.calls.includes("setConfirmed:false"));
  assert.ok(h.calls.includes("setError:"));
});

test("409 STALE：清预览与勾选、不假成功、不 reload", async () => {
  const h = harness({
    confirmed: true,
    apiOverrides: {
      confirm: () => Promise.reject(new ApiError("CONFLICT", "绑定已变化", 409, { code: "BOOTH_CORRECTION_STALE" })),
    },
  });
  await h.handlers.confirm();
  assert.ok(h.calls.includes("setPreview:null"), "STALE 必须清掉旧预览");
  assert.ok(h.calls.includes("setConfirmed:false"), "STALE 必须清掉勾选");
  assert.equal(h.calls.includes("reload"), false, "STALE 不得当成功刷新");
  assert.equal(h.calls.some((c) => c.startsWith("toast:ok:")), false, "STALE 不得假成功");
  assert.ok(h.calls.some((c) => c.startsWith("toast:bad:")), "STALE 必须提示重新预览");
});

// ---------------- ③ 静态补充（非 DOM） ----------------

const DETAIL = fileURLToPath(new URL("../../apps/web/src/components/ItemDetail.tsx", import.meta.url));
const SECTION = fileURLToPath(new URL("../../apps/web/src/components/BoothCorrectionSection.tsx", import.meta.url));

test("ItemDetail 有更正入口且只在已有 BOOTH 链接时渲染；section 无挂载自动请求（静态补充）", () => {
  const detail = readFileSync(DETAIL, "utf8");
  assert.ok(detail.includes("BoothCorrectionSection"), "ItemDetail 必须渲染 BoothCorrectionSection");
  assert.ok(/boothUrlFromItem\s*&&/.test(detail), "入口必须受已有 BOOTH 链接约束");

  const section = readFileSync(SECTION, "utf8");
  assert.ok(section.includes("更正 BOOTH"), "section 必须有「更正 BOOTH」入口文案");
  assert.equal(/useEffect\([^)]*\)\s*=>\s*\{[^}]*api\.preview/.test(section), false, "挂载时不得自动 preview");
});
