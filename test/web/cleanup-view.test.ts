/**
 * 整理待办 UI（P4-T4 brief Step 1；cleanup-todos spec §6.1/§6.2/§6.3/§7.2）。
 *
 * 三层证据，明确区分能力：
 * 1) 纯函数正反例（ruleLabel / resolvedLabel / countsCaption / evidenceText / filterBody）；
 * 2) 关闭网络的 fetch stub：证明 8 个已准端点的 method/URL/query/JSON body、显式 local 策略与 CAS；
 * 3) 源码接线 AST 静态门 + 真实 handler 函数体执行（注入依赖桩），证明面板真的接到这些调用；
 *    这**不是** DOM/浏览器执行 —— 真实挂载与交互验收归 task34。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { CleanupFilter, CleanupTodoRow, ItemCardWeb } from "../../apps/web/src/types";
import {
  CLEANUP_RULES, DEFAULT_LOCAL_POLICY, MISSING_FILE_NOTE, countsCaption, evidenceText,
  filterBody, resolvedLabel, ruleLabel, savedFilterToState, type CleanupListState,
} from "../../apps/web/src/cleanup-view";
import {
  ApiError, createCleanupFilter, deleteCleanupFilter, ignoreCleanupTodo, listCleanupFilters,
  listCleanupIgnores, listCleanupTodos, restoreCleanupIgnore, updateCleanupFilter,
} from "../../apps/web/src/api";

// ---------------- 纯函数 ----------------

test("规则文案与 resolved 文案固定", () => {
  assert.equal(ruleLabel("missing_cover"), "缺封面");
  assert.equal(ruleLabel("missing_file"), "文件失联");
  assert.equal(resolvedLabel(true), "问题当前不存在");
  assert.equal(resolvedLabel(false), "问题当前存在");
  assert.match(countsCaption({ missing_cover: { total: 1, ignored: 0 }, missing_source: { total: 2, ignored: 1, localExcluded: 3 }, unlinked_model: { total: 0, ignored: 0 }, missing_file: { total: 0, ignored: 0 } }), /被排除 3 条/);
});

test("四类规则文案齐全；resolved=null（普通待办行）不冒充已解决/未解决", () => {
  assert.deepEqual(CLEANUP_RULES.map(ruleLabel), ["缺封面", "缺来源", "未关联模型", "文件失联"]);
  assert.equal(resolvedLabel(null), "");
  assert.notEqual(resolvedLabel(null), resolvedLabel(true));
  assert.notEqual(resolvedLabel(null), resolvedLabel(false));
});

test("counts 文案：四类计数 + 已忽略子集 + 合计 + 被排除数，并注明口径", () => {
  const cap = countsCaption({
    total: 6,
    missing_cover: { total: 1, ignored: 0 },
    missing_source: { total: 2, ignored: 1, localExcluded: 3 },
    unlinked_model: { total: 3, ignored: 2 },
    missing_file: { total: 0, ignored: 0 },
  });
  assert.match(cap, /缺封面 1（已忽略 0）/);
  assert.match(cap, /缺来源 2（已忽略 1）/);
  assert.match(cap, /未关联模型 3（已忽略 2）/);
  assert.match(cap, /文件失联 0（已忽略 0）/);
  assert.match(cap, /合计 6 行/);
  assert.match(cap, /规则命中计数/);
  assert.match(cap, /已忽略数是当前命中行中的子集/);
  assert.match(cap, /被排除 3 条 local 条目（不是待办）/);
  // 反例：localExcluded=0 也要显式写出来，不能静默省略
  assert.match(countsCaption({
    missing_cover: { total: 0, ignored: 0 },
    missing_source: { total: 0, ignored: 0, localExcluded: 0 },
    unlinked_model: { total: 0, ignored: 0 },
    missing_file: { total: 0, ignored: 0 },
  }), /被排除 0 条/);
});

function card(overrides: Partial<ItemCardWeb> = {}): ItemCardWeb {
  return {
    id: 7, title: "示例条目", sourceSite: "booth", sourceItemId: "1", sourceUrl: null, shopName: null,
    status: "active", favorite: 0, adult: 0, coverImageId: null, coverUrl: null,
    imageCount: 0, assetCount: 0, totalBytes: 0, avatars: [], tags: [], compatDeclaredCount: 0,
    collections: [], category: null, suggestion: null, updatedAt: "2026-11-04T02:00:00.000Z",
    ...overrides,
  };
}

test("evidence 文案按 rule 读真实字段；其它规则不得盲读 imageCount", () => {
  const cover: CleanupTodoRow = { item: card(), rule: "missing_cover", ignored: false, resolved: null, evidence: { imageCount: 0 } };
  const source: CleanupTodoRow = { item: card(), rule: "missing_source", ignored: false, resolved: null, evidence: { sourceSite: "booth", sourceGone: 0 } };
  const model: CleanupTodoRow = { item: card(), rule: "unlinked_model", ignored: false, resolved: null, evidence: { itemAvatarCount: 0, assetAvatarCount: 2 } };
  const file: CleanupTodoRow = { item: card(), rule: "missing_file", ignored: false, resolved: null, evidence: { missingAssetCount: 1 } };

  assert.match(evidenceText(cover), /库内图片 0 张/);
  assert.match(evidenceText(source), /来源站点 booth/);
  assert.match(evidenceText(source), /source_gone=0/);
  assert.match(evidenceText(model), /条目关联模型 0 个/);
  assert.match(evidenceText(model), /资产关联模型 2 个/);
  assert.match(evidenceText(file), /缺失资产 1 个/);
  // 反例：非 missing_cover 行不得出现 imageCount 文案（types 已按 rule 收窄）
  assert.equal(/imageCount/.test(evidenceText(source)), false);
  assert.equal(/imageCount/.test(evidenceText(model)), false);
  assert.equal(/imageCount/.test(evidenceText(file)), false);
});

test("保存筛选 JSON 用服务端实际键（avatarIds/categoryIds/localSourcePolicy），不是 query 的 CSV 键", () => {
  const state: CleanupListState = {
    rule: "missing_cover", q: "  shinano  ", avatarIds: [1, 2], categoryIds: ["clothing.tops"],
    ignored: "show", sort: "title", localSourcePolicy: "exclude_local", limit: 20, offset: 40,
  };
  const body = filterBody(state);
  assert.deepEqual(body, {
    rule: "missing_cover", q: "shinano", avatarIds: [1, 2], categoryIds: ["clothing.tops"],
    ignored: "show", sort: "title", localSourcePolicy: "exclude_local", limit: 20,
  });
  assert.equal("avatar" in body, false);
  assert.equal("category" in body, false);
  assert.equal("offset" in body, false);
  assert.equal("includeArchived" in body, false);
  assert.equal("includeTrashed" in body, false);

  // 反例：空数组/空 q 不写进 filter（服务端严格校验未知/空值）
  const minimal = filterBody({ localSourcePolicy: "include_local", q: "   ", avatarIds: [], categoryIds: [] });
  assert.deepEqual(minimal, { localSourcePolicy: "include_local" });

  // 应用保存筛选：恢复成 UI 状态，策略必选、offset 归零
  const back = savedFilterToState(body);
  assert.equal(back.localSourcePolicy, "exclude_local");
  assert.deepEqual(back.avatarIds, [1, 2]);
  assert.equal(back.offset, 0);
  assert.equal(back.ignored, "show");
});

test("默认 local 策略是 include_local（用户 m00868 已准），不是未选/排除", () => {
  assert.equal(DEFAULT_LOCAL_POLICY, "include_local");
  assert.notEqual(DEFAULT_LOCAL_POLICY, "exclude_local");
});

// ---------------- 本模块 typed API（关闭网络 fetch stub；不发真实 HTTP） ----------------

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

test("8 个整理端点：method/URL/query/body、显式 local 策略与 CAS expectedVersion", async () => {
  const stub = stubFetch((call) => {
    if (call.url.startsWith("/api/cleanup/todos")) return json({ total: 0, counts: {}, items: [] });
    if (call.url.startsWith("/api/cleanup/ignores")) return json({ total: 0, ignores: [] });
    if (call.url === "/api/cleanup/ignore" && call.method === "POST") return json({ ignore: { itemId: 7, rule: "missing_cover", note: null, ignoredAt: "x", resolved: false, item: { id: 7, title: "t", status: "active" } } });
    if (call.url.startsWith("/api/cleanup/ignore/")) return json({ removed: 1 });
    if (call.url === "/api/cleanup/filters" && call.method === "GET") return json({ filters: [] });
    if (call.url === "/api/cleanup/filters" && call.method === "POST") return json({ filter: { id: 3, name: "f", filter: { localSourcePolicy: "include_local" }, version: 1, createdAt: "x", updatedAt: "x" } }, 201);
    if (call.url.startsWith("/api/cleanup/filters/")) return json({ filter: { id: 3, name: "g", filter: { localSourcePolicy: "include_local" }, version: 3, createdAt: "x", updatedAt: "x" } });
    return json({ error: { code: "NOT_FOUND", message: "unexpected" } }, 404);
  });
  try {
    await listCleanupTodos({
      rule: "missing_cover", ignored: "show", q: "shinano", avatarIds: [1, 2], categoryIds: ["clothing.tops"],
      sort: "title", localSourcePolicy: "include_local", limit: 20, offset: 40,
    });
    const todos = new URL(stub.calls[0].url, "http://x");
    assert.equal(stub.calls[0].method, "GET");
    assert.equal(todos.pathname, "/api/cleanup/todos");
    assert.equal(todos.searchParams.get("rule"), "missing_cover");
    assert.equal(todos.searchParams.get("ignored"), "show");
    assert.equal(todos.searchParams.get("q"), "shinano");
    assert.equal(todos.searchParams.get("avatar"), "1,2");
    assert.equal(todos.searchParams.get("category"), "clothing.tops");
    assert.equal(todos.searchParams.get("sort"), "title");
    assert.equal(todos.searchParams.get("localSourcePolicy"), "include_local");
    assert.equal(todos.searchParams.get("limit"), "20");
    assert.equal(todos.searchParams.get("offset"), "40");

    await listCleanupIgnores({ resolved: "true", localSourcePolicy: "exclude_local", limit: 10 });
    const ignores = new URL(stub.calls[1].url, "http://x");
    assert.equal(stub.calls[1].method, "GET");
    assert.equal(ignores.pathname, "/api/cleanup/ignores");
    assert.equal(ignores.searchParams.get("resolved"), "true");
    assert.equal(ignores.searchParams.get("localSourcePolicy"), "exclude_local");
    assert.equal(ignores.searchParams.get("limit"), "10");

    await ignoreCleanupTodo({ itemId: 7, rule: "missing_cover", note: "稍后处理" });
    assert.equal(stub.calls[2].method, "POST");
    assert.equal(stub.calls[2].url, "/api/cleanup/ignore");
    assert.deepEqual(stub.calls[2].body, { itemId: 7, rule: "missing_cover", note: "稍后处理" });

    await restoreCleanupIgnore(7, "missing_cover");
    assert.equal(stub.calls[3].method, "DELETE");
    assert.equal(stub.calls[3].url, "/api/cleanup/ignore/7/missing_cover");

    await listCleanupFilters();
    assert.equal(stub.calls[4].method, "GET");
    assert.equal(stub.calls[4].url, "/api/cleanup/filters");

    const filter: CleanupFilter = { localSourcePolicy: "include_local", rule: "missing_cover" };
    await createCleanupFilter({ name: "f", filter });
    assert.equal(stub.calls[5].method, "POST");
    assert.equal(stub.calls[5].url, "/api/cleanup/filters");
    assert.deepEqual(stub.calls[5].body, { name: "f", filter });

    await updateCleanupFilter(3, { name: "g", expectedVersion: 2 });
    assert.equal(stub.calls[6].method, "PATCH");
    assert.equal(stub.calls[6].url, "/api/cleanup/filters/3");
    assert.deepEqual(stub.calls[6].body, { name: "g", expectedVersion: 2 });

    await deleteCleanupFilter(3);
    assert.equal(stub.calls[7].method, "DELETE");
    assert.equal(stub.calls[7].url, "/api/cleanup/filters/3");
  } finally { stub.restore(); }
});

test("缺 local 策略的 400 子码原样带出（LOCAL_POLICY_REQUIRED），不静默补默认", async () => {
  const stub = stubFetch(() => json({
    error: { code: "INVALID_INPUT", message: "localSourcePolicy 必填", details: { code: "LOCAL_POLICY_REQUIRED" } },
  }, 400));
  try {
    await assert.rejects(listCleanupTodos({ localSourcePolicy: "include_local" }), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 400);
      assert.equal(err.code, "INVALID_INPUT");
      assert.equal(err.details?.code, "LOCAL_POLICY_REQUIRED");
      return true;
    });
  } finally { stub.restore(); }
});

// ---------------- 源码接线静态门（AST；不是 DOM 执行） ----------------

const PANEL_PATH = fileURLToPath(new URL("../../apps/web/src/components/CleanupPanel.tsx", import.meta.url));

function astOf(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

function apiImports(sf: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    if (!ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== "../api") continue;
    const nb = st.importClause?.namedBindings;
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) names.push(el.name.text);
  }
  return names;
}

test("面板接到 8 个真实端点；四 tabs/搜索/头像分类/已忽略/独立管理/保存筛选都在 JSX", () => {
  const sf = astOf(PANEL_PATH);
  const imports = apiImports(sf);
  for (const fn of ["listCleanupTodos", "listCleanupIgnores", "ignoreCleanupTodo", "restoreCleanupIgnore", "listCleanupFilters", "createCleanupFilter", "updateCleanupFilter", "deleteCleanupFilter"]) {
    assert.ok(imports.includes(fn), "CleanupPanel 未从 ../api 导入 " + fn);
  }
  const text = readFileSync(PANEL_PATH, "utf8");
  for (const s of ["整理待办", "已忽略管理", "保存筛选", "排除本地条目", "包含本地条目", "恢复", "忽略", "搜索"]) {
    assert.ok(text.includes(s), "面板缺少文案/入口：" + s);
  }
  assert.ok(text.includes("MISSING_FILE_NOTE"), "missing_file 行必须显示非实时磁盘检查提示");
  assert.ok(text.includes("resolvedLabel"), "已忽略行必须由 resolved 驱动文案");
  assert.ok(text.includes("countsCaption"), "必须显示四类计数");
  assert.ok(text.includes("ruleLabel"), "tab/行必须用固定规则文案");
  assert.ok(text.includes("DEFAULT_LOCAL_POLICY"), "默认策略必须来自固定常量");
  // 策略下拉：两个选项、无空选项（无“未选”提交态）
  const at = text.indexOf("value={policy}");
  assert.ok(at > 0, "未找到策略下拉");
  const block = text.slice(at, text.indexOf("</select>", at));
  assert.ok(block.includes('value="exclude_local"'), "策略下拉缺 exclude_local");
  assert.ok(block.includes('value="include_local"'), "策略下拉缺 include_local");
  assert.equal(block.includes('value=""'), false, "策略下拉不得有未选项");
});

// ---------------- 真实 handler 体执行（TS 去类型 + 注入依赖；不是 DOM 执行） ----------------

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
  const factory = new Function(...deps, js + "\nreturn __h;") as (...vals: unknown[]) => (...args: unknown[]) => unknown;
  return factory;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test("忽略：POST 后按所选策略重拉 todos（不拿 POST 的 include_local 视图当真相），管理页同步刷新", async () => {
  const sf = astOf(PANEL_PATH);
  const calls: string[] = [];
  const factory = buildHandler(sf, "ignoreRow", ["setBusy", "ignoreCleanupTodo", "toast", "reloadTodos", "reloadIgnores", "managementOpen", "errorText"]);
  const handler = factory(
    (v: unknown) => calls.push("busy:" + String(v)),
    (body: unknown) => { calls.push("ignore:" + JSON.stringify(body)); return Promise.resolve({ ignore: {} }); },
    (kind: string, text: string) => calls.push("toast:" + kind + ":" + text),
    () => calls.push("reloadTodos"),
    () => calls.push("reloadIgnores"),
    true,
    (e: unknown) => "ERR:" + String(e),
  );
  const row: CleanupTodoRow = { item: card(), rule: "missing_cover", ignored: false, resolved: null, evidence: { imageCount: 0 } };
  handler(row);
  await flush();
  assert.ok(calls.includes('ignore:{"itemId":7,"rule":"missing_cover"}'), "必须真的 POST ignore(itemId, rule)");
  assert.ok(calls.includes("reloadTodos"), "必须按所选策略重拉 todos");
  assert.ok(calls.includes("reloadIgnores"), "管理页打开时必须刷新忽略列表");
  assert.ok(calls.some((c) => c.startsWith("toast:ok:")), "成功要有反馈");
});

test("恢复：DELETE 后重拉 todos；管理页关闭时不额外拉 ignores", async () => {
  const sf = astOf(PANEL_PATH);
  const calls: string[] = [];
  const factory = buildHandler(sf, "restoreIgnore", ["setBusy", "restoreCleanupIgnore", "toast", "reloadTodos", "reloadIgnores", "managementOpen", "errorText"]);
  const handler = factory(
    (v: unknown) => calls.push("busy:" + String(v)),
    (itemId: number, rule: string) => { calls.push("restore:" + itemId + ":" + rule); return Promise.resolve({ removed: 1 }); },
    (kind: string, text: string) => calls.push("toast:" + kind + ":" + text),
    () => calls.push("reloadTodos"),
    () => calls.push("reloadIgnores"),
    false,
    (e: unknown) => "ERR:" + String(e),
  );
  handler(7, "missing_cover");
  await flush();
  assert.ok(calls.includes("restore:7:missing_cover"), "必须真的 DELETE 忽略行");
  assert.ok(calls.includes("reloadTodos"), "恢复后必须重拉 todos");
  assert.equal(calls.includes("reloadIgnores"), false, "管理页关闭时不必额外拉 ignores");
});

test("保存筛选：POST body 的 filter 带当前所选策略（不是硬编码 include_local）", async () => {
  const sf = astOf(PANEL_PATH);
  const calls: string[] = [];
  const state: CleanupListState = {
    rule: "missing_cover", q: "x", avatarIds: [1], categoryIds: ["a"], ignored: "hide",
    sort: "updated", localSourcePolicy: "exclude_local", limit: 50, offset: 0,
  };
  const factory = buildHandler(sf, "saveFilter", ["filterName", "toast", "setBusy", "createCleanupFilter", "filterBody", "listState", "setFilterName", "setSelectedFilterId", "reloadFilters", "errorText"]);
  const handler = factory(
    "我的筛选",
    (kind: string, text: string) => calls.push("toast:" + kind + ":" + text),
    (v: unknown) => calls.push("busy:" + String(v)),
    (body: unknown) => { calls.push("create:" + JSON.stringify(body)); return Promise.resolve({ filter: { id: 3, name: "我的筛选" } }); },
    filterBody,
    state,
    (v: unknown) => calls.push("name:" + String(v)),
    (v: unknown) => calls.push("selected:" + String(v)),
    () => calls.push("reloadFilters"),
    (e: unknown) => "ERR:" + String(e),
  );
  handler();
  await flush();
  const created = calls.find((c) => c.startsWith("create:"));
  assert.ok(created, "必须真的 POST 保存筛选");
  const body = JSON.parse(created!.slice("create:".length)) as { name: string; filter: CleanupFilter };
  assert.equal(body.name, "我的筛选");
  assert.equal(body.filter.localSourcePolicy, "exclude_local");
  assert.deepEqual(body.filter.avatarIds, [1]);
  assert.ok(calls.includes("reloadFilters"), "保存后必须刷新筛选列表");
});

test("改名 CAS 409：提示「已被其他操作修改，请刷新」并重拉筛选（不静默覆盖）", async () => {
  const sf = astOf(PANEL_PATH);
  const calls: string[] = [];
  const factory = buildHandler(sf, "renameFilter", ["filters", "selectedFilterId", "renaming", "toast", "setBusy", "updateCleanupFilter", "setRenaming", "reloadFilters", "ApiError", "describeError", "errorText"]);
  const handler = factory(
    [{ id: 3, name: "旧名", filter: { localSourcePolicy: "include_local" }, version: 2, createdAt: "x", updatedAt: "x" }],
    3,
    "新名",
    (kind: string, text: string) => calls.push("toast:" + kind + ":" + text),
    (v: unknown) => calls.push("busy:" + String(v)),
    (id: number, body: unknown) => { calls.push("patch:" + id + ":" + JSON.stringify(body)); return Promise.reject(new ApiError("CONFLICT", "筛选版本冲突", 409, { code: "FILTER_VERSION_CONFLICT" })); },
    (v: unknown) => calls.push("renaming:" + String(v)),
    () => calls.push("reloadFilters"),
    ApiError,
    (e: unknown) => "ERR:" + String(e),
    (e: unknown) => "ERR:" + String(e),
  );
  handler();
  await flush();
  assert.ok(calls.includes('patch:3:{"name":"新名","expectedVersion":2}'), "必须用详情 version 做 CAS");
  assert.ok(calls.some((c) => c.startsWith("toast:bad:") && c.includes("已被其他操作修改，请刷新")), "409 必须提示刷新");
  assert.ok(calls.includes("reloadFilters"), "409 后必须重拉筛选（刷新确认）");
});
