/**
 * SALT 首次确认（task-50；契约 /root/Code/.asset-vault-followup-20261105/salt-approval-and-contract.md）。
 *
 * 三层证据，能力边界写清：
 * ① api wrapper：关闭网络的 fetch stub，断言 method/path/JSON body 与 409 details 形状；
 * ② 真实组件 handler 体：从 RegisterAvatarSection.tsx 抽出真实函数体 + 注入依赖执行（TS 去类型），
 *    证明「确认/取消/冲突复用」的真实分支与请求体 —— **不是 DOM/React 事件执行**；
 * ③ 源码接线静态补充：ItemDetail 渲染入口、App 刷新回调、无挂载自动 POST。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ApiError, avatarConflictOf, registerAvatar } from "../../apps/web/src/api";

// ---------------- ① api wrapper（闭网 fetch stub） ----------------

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

test("新建：POST /api/items/:id/register-avatar，body 只有 name/aliases/owned", async () => {
  const stub = stubFetch(() => json({ avatarId: 3, created: true }));
  try {
    const r = await registerAvatar(7, { name: "SALT", aliases: ["Salt"], owned: true });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].method, "POST");
    assert.equal(stub.calls[0].url, "/api/items/7/register-avatar");
    assert.deepEqual(stub.calls[0].body, { name: "SALT", aliases: ["Salt"], owned: true });
    assert.deepEqual(r, { avatarId: 3, created: true });
  } finally { stub.restore(); }
});

test("复用：body 只有 existingAvatarId/owned，绝不混传 name/aliases", async () => {
  const stub = stubFetch(() => json({ avatarId: 12, created: false }));
  try {
    const r = await registerAvatar(7, { existingAvatarId: 12, owned: true });
    const body = stub.calls[0].body as Record<string, unknown>;
    assert.equal(stub.calls[0].url, "/api/items/7/register-avatar");
    assert.deepEqual(Object.keys(body).sort(), ["existingAvatarId", "owned"]);
    assert.equal("name" in body, false);
    assert.equal("aliases" in body, false);
    assert.equal(r.created, false);
  } finally { stub.restore(); }
});

test("409 同名冲突：details.code/avatarId/avatarName 原样带出，可被 avatarConflictOf 识别", async () => {
  const stub = stubFetch(() => json({
    error: { code: "CONFLICT", message: "同名模型已存在", details: { code: "AVATAR_NAME_CONFLICT", avatarId: 12, avatarName: "SALT" } },
  }, 409));
  try {
    await assert.rejects(registerAvatar(7, { name: "SALT", owned: true }), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "CONFLICT");
      assert.equal(err.details?.code, "AVATAR_NAME_CONFLICT");
      const c = avatarConflictOf(err);
      assert.deepEqual(c, { code: "AVATAR_NAME_CONFLICT", avatarId: 12, avatarName: "SALT" });
      return true;
    });
  } finally { stub.restore(); }
});

test("409 别名冲突：AVATAR_ALIAS_CONFLICT 同样可识别；404/400 不误判为冲突", async () => {
  const alias = stubFetch(() => json({
    error: { code: "CONFLICT", message: "别名已被占用", details: { code: "AVATAR_ALIAS_CONFLICT", avatarId: 9, avatarName: "Sio" } },
  }, 409));
  try {
    await assert.rejects(registerAvatar(7, { name: "SALT", aliases: ["Sio"], owned: true }), (err: unknown) => {
      assert.deepEqual(avatarConflictOf(err), { code: "AVATAR_ALIAS_CONFLICT", avatarId: 9, avatarName: "Sio" });
      return true;
    });
  } finally { alias.restore(); }

  const missing = stubFetch(() => json({ error: { code: "NOT_FOUND", message: "条目不存在" } }, 404));
  try {
    await assert.rejects(registerAvatar(7, { name: "SALT", owned: true }), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 404);
      assert.equal(avatarConflictOf(err), null);
      return true;
    });
  } finally { missing.restore(); }
});

// ---------------- ② 真实组件 handler 体（TS 去类型 + 注入依赖；非 DOM） ----------------

const SECTION_PATH = fileURLToPath(new URL("../../apps/web/src/components/RegisterAvatarSection.tsx", import.meta.url));
const ITEM_DETAIL_PATH = fileURLToPath(new URL("../../apps/web/src/components/ItemDetail.tsx", import.meta.url));
const APP_PATH = fileURLToPath(new URL("../../apps/web/src/App.tsx", import.meta.url));

function astOf(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

function handlerExpr(sf: ts.SourceFile, name: string): string {
  let out = "";
  walk(sf, (n) => {
    if (out) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      out = n.initializer.getText(sf);
    }
  });
  assert.ok(out, "未找到 handler: " + name);
  return out;
}

function buildHandler(sf: ts.SourceFile, name: string, deps: string[]): (...vals: unknown[]) => (...args: unknown[]) => unknown {
  const expr = handlerExpr(sf, name);
  const js = ts.transpileModule("const __h = " + expr + ";", {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(...deps, js + "\nreturn __h;") as (...vals: unknown[]) => (...args: unknown[]) => unknown;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

interface Harness {
  calls: string[];
  state: Record<string, unknown>;
  handler: (...args: unknown[]) => unknown;
}

/** 组装 confirmRegister / confirmReuse / cancel / toggleOpen 的真实 handler。 */
function harness(name: string, opts: { name?: string; aliasesText?: string; owned?: boolean; conflict?: unknown; respond?: (body: unknown) => Promise<unknown> } = {}): Harness {
  const sf = astOf(SECTION_PATH);
  const calls: string[] = [];
  const state: Record<string, unknown> = { name: opts.name ?? "", aliasesText: opts.aliasesText ?? "", owned: opts.owned ?? true, conflict: opts.conflict ?? null };
  const deps = [
    "itemId", "name", "aliasesText", "owned", "conflict",
    "setBusy", "setError", "setConflict", "setOpen", "setName", "setAliasesText", "setOwned",
    "registerAvatar", "onRegistered", "onToast", "describeError", "avatarConflictOf",
  ];
  const factory = buildHandler(sf, name, deps);
  const handler = factory(
    7,
    state.name,
    state.aliasesText,
    state.owned,
    state.conflict,
    (v: unknown) => calls.push("setBusy:" + String(v)),
    (v: unknown) => { state.error = v; calls.push("setError:" + String(v)); },
    (v: unknown) => { state.conflict = v; calls.push("setConflict:" + JSON.stringify(v)); },
    (v: unknown) => { state.open = v; calls.push("setOpen:" + String(v)); },
    (v: unknown) => { state.name = v; calls.push("setName:" + String(v)); },
    (v: unknown) => { state.aliasesText = v; calls.push("setAliasesText:" + String(v)); },
    (v: unknown) => { state.owned = v; calls.push("setOwned:" + String(v)); },
    (itemId: number, body: unknown) => {
      calls.push("register:" + itemId + ":" + JSON.stringify(body));
      return opts.respond ? opts.respond(body) : Promise.resolve({ avatarId: 3, created: true });
    },
    (r: unknown) => calls.push("onRegistered:" + JSON.stringify(r)),
    (kind: string, text: string) => calls.push("toast:" + kind + ":" + text),
    (e: unknown) => "ERR:" + String((e as Error)?.message ?? e),
    avatarConflictOf,
  );
  return { calls, state, handler };
}

test("确认：真实 handler 提交 name/aliases/owned，成功后回调父并关闭表单", async () => {
  const h = harness("confirmRegister", { name: "  SALT  ", aliasesText: "Salt, ソルト、SALT2", owned: true });
  await h.handler();
  await flush();
  assert.deepEqual(h.calls.filter((c) => c.startsWith("register:")), [
    'register:7:{"name":"SALT","aliases":["Salt","ソルト","SALT2"],"owned":true}',
  ]);
  assert.ok(h.calls.includes('onRegistered:{"avatarId":3,"created":true}'), "成功后必须回调父刷新");
  assert.ok(h.calls.includes("setOpen:false"), "成功后关闭表单");
});

test("确认：空名不发请求；取消/只点开都不 POST", async () => {
  const empty = harness("confirmRegister", { name: "   " });
  await empty.handler();
  await flush();
  assert.equal(empty.calls.some((c) => c.startsWith("register:")), false, "空名不得 POST");
  assert.ok(empty.calls.some((c) => c.startsWith("setError:")), "空名必须提示");

  const cancel = harness("cancel");
  await cancel.handler();
  await flush();
  assert.equal(cancel.calls.some((c) => c.startsWith("register:")), false, "取消不得 POST");
  assert.ok(cancel.calls.includes("setOpen:false"));

  const toggle = harness("toggleOpen");
  await toggle.handler();
  await flush();
  assert.equal(toggle.calls.some((c) => c.startsWith("register:")), false, "只点开不得 POST");
});

test("409 冲突：不静默复用，先展示已有模型；用户再次确认才用 existingAvatarId", async () => {
  const conflict = { code: "AVATAR_NAME_CONFLICT", avatarId: 12, avatarName: "SALT" };
  // 真实 409 响应经真实 request() 解析（不是手搓 ApiError）：details 必须带 code/avatarId/avatarName。
  const stub = stubFetch(() => json({
    error: { code: "CONFLICT", message: "同名模型已存在", details: conflict },
  }, 409));
  try {
    const h = harness("confirmRegister", { name: "SALT", respond: () => registerAvatar(7, { name: "SALT", owned: true }) });
    await h.handler();
    await flush();
    assert.equal(h.calls.filter((c) => c.startsWith("register:")).length, 1, "冲突时只发一次新建请求");
    assert.equal(h.calls.some((c) => c.startsWith("onRegistered:")), false, "冲突不得当成功");
    // 强断言（S6 I-1）：必须真的进入冲突确认态并带出已有模型。
    // 旧写法 startsWith("setConflict:") 会被 confirmRegister 开头的 setConflict(null) 满足，等于空转。
    assert.ok(
      h.calls.includes('setConflict:{"code":"AVATAR_NAME_CONFLICT","avatarId":12,"avatarName":"SALT"}'),
      "必须进入冲突确认态并带出已有模型，实得：" + h.calls.filter((c) => c.startsWith("setConflict:")).join(" | "),
    );
    assert.deepEqual(h.state.conflict, conflict, "冲突态必须是完整对象（code/avatarId/avatarName）");
    // 注意：confirmRegister 开头会无条件 setError("")，所以这里只排除「非空错误」——
    // 与 I-1 同型的空转陷阱（startsWith 被无条件清空满足）。
    assert.equal(h.calls.some((c) => c.startsWith("setError:") && c !== "setError:"), false, "冲突不应走普通错误提示");
  } finally { stub.restore(); }

  const reuse = harness("confirmReuse", { conflict, owned: true });
  await reuse.handler();
  await flush();
  assert.deepEqual(reuse.calls.filter((c) => c.startsWith("register:")), [
    'register:7:{"existingAvatarId":12,"owned":true}',
  ]);
  assert.ok(reuse.calls.some((c) => c.startsWith("onRegistered:")), "复用成功也要回调父");
});

test("负面对照：409 缺 avatarId/avatarName 不进入确认态（证明上面的断言不是空转）", async () => {
  const stub = stubFetch(() => json({
    error: { code: "CONFLICT", message: "同名模型已存在", details: { code: "AVATAR_NAME_CONFLICT" } },
  }, 409));
  try {
    const h = harness("confirmRegister", { name: "SALT", respond: () => registerAvatar(7, { name: "SALT", owned: true }) });
    await h.handler();
    await flush();
    assert.equal(h.state.conflict, null, "缺 avatarId/avatarName 不得进入确认态");
    assert.ok(h.calls.some((c) => c.startsWith("setError:") && c !== "setError:"), "应走普通错误提示");
  } finally { stub.restore(); }
});

test("owned 勾选：默认 true 写 1 语义；取消勾选传 false（不撤销已有 owned=1 由服务端保证）", async () => {
  const on = harness("confirmRegister", { name: "SALT", owned: true });
  await on.handler(); await flush();
  assert.ok(on.calls.some((c) => c.includes('"owned":true')));

  const off = harness("confirmRegister", { name: "SALT", owned: false });
  await off.handler(); await flush();
  assert.ok(off.calls.some((c) => c.includes('"owned":false')));
});

// ---------------- ③ 源码接线静态补充（非 DOM） ----------------

test("ItemDetail 渲染入口 + App 刷新父列表 + 无挂载自动 POST（静态补充）", () => {
  const detail = readFileSync(ITEM_DETAIL_PATH, "utf8");
  assert.ok(detail.includes("RegisterAvatarSection"), "ItemDetail 必须渲染 RegisterAvatarSection");
  assert.ok(detail.includes("设为模型本体"), "必须有显式「设为模型本体」入口文案");

  const app = readFileSync(APP_PATH, "utf8");
  assert.ok(/onAvatarRegistered=\{\(\)\s*=>\s*\{[^}]*loadAvatars\(\)/.test(app), "App 必须在注册成功后刷新 avatars");

  const sf = astOf(SECTION_PATH);
  let inEffect = 0;
  walk(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "useEffect") {
      for (const a of n.arguments) {
        const names: string[] = [];
        walk(a, (x) => { if (ts.isCallExpression(x) && ts.isIdentifier(x.expression)) names.push(x.expression.text); });
        if (names.includes("registerAvatar")) inEffect += 1;
      }
    }
  });
  assert.equal(inEffect, 0, "挂载/依赖变化时不得自动 POST");
});
