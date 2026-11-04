/**
 * 搭配清单 UI（P3-T4 brief Step 1；spec §7 / §6.2 / §6.3）。
 *
 * 三层证据，明确区分能力：
 * 1) 纯函数正反例（stateLabel / countsCaption / reorderPayload / 证据与冲突文案）；
 * 2) 关闭网络的 fetch stub：证明 9 个已准端点的 method/URL/JSON body 与 CAS expectedVersion；
 * 3) 源码接线 AST 静态门：证明面板/按钮真的接到这些调用（不是只有三个纯函数），
 *    但**不是** DOM/浏览器执行 —— 真实挂载与交互验收归 P1-T5/task34。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Loadout, LoadoutDetail, LoadoutItem } from "../../apps/web/src/types";
import {
  conflictHint, countsCaption, evidenceLabel, evidenceMark, listTotalCaption,
  reorderPayload, stateLabel, visibleReorderIds,
} from "../../apps/web/src/loadout-view";
import {
  ApiError, addLoadoutItems, createLoadout, deleteLoadout, getLoadout, listAvatarLoadouts,
  patchLoadout, patchLoadoutItem, removeLoadoutItem, reorderLoadoutItems,
} from "../../apps/web/src/api";

// ---------------- 纯函数 ----------------

test("状态文案带「手动」限定；不得把清单状态叫成已导入/已验证", () => {
  assert.equal(stateLabel("planned"), "准备使用");
  assert.equal(stateLabel("imported"), "已导入（手动）");
  assert.equal(stateLabel("verified"), "已验证（手动）");
  // 反例：去掉限定就是 spec §7.3 禁止的写法
  assert.notEqual(stateLabel("imported"), "已导入");
  assert.notEqual(stateLabel("verified"), "已验证");
  for (const s of ["imported", "verified"] as const) assert.ok(stateLabel(s).includes("手动"), s);
});

test("counts 文案注明含回收站；三口径（stateCounts / trashedCount / 当前列表 total）分开", () => {
  const cap = countsCaption({ stateCounts: { planned: 3, imported: 0, verified: 0 }, trashedCount: 2 });
  assert.match(cap, /含回收站条目/);
  assert.match(cap, /准备使用 3/);
  assert.match(cap, /回收站 2/);
  // 反例：trashedCount=0 也要能读出来，且不把 0 吞掉
  assert.match(countsCaption({ stateCounts: { planned: 0, imported: 1, verified: 2 }, trashedCount: 0 }), /回收站 0/);

  // 当前列表 total 是第三个口径：受 state/includeTrashedItems 影响，不能拿 stateCounts 冒充
  assert.match(listTotalCaption(5, { state: null, includeTrashed: false }), /当前列表 5 条/);
  assert.match(listTotalCaption(5, { state: null, includeTrashed: true }), /含回收站/);
  assert.match(listTotalCaption(5, { state: "planned", includeTrashed: false }), /准备使用/);
  assert.notEqual(listTotalCaption(5, { state: null, includeTrashed: false }), cap);
});

test("reorderPayload 保留通用全量形状，但面板只提交可见行（hiddenIds=[]）", () => {
  assert.deepEqual(reorderPayload([3, 1], [2]), [3, 1, 2]);
  assert.deepEqual(reorderPayload([3, 1], []), [3, 1]);
  assert.deepEqual(reorderPayload([], []), []);
  // 不改入参（面板 state 里的顺序不能被 helper 就地改掉）
  const visible = [3, 1];
  const hidden = [2];
  reorderPayload(visible, hidden);
  assert.deepEqual(visible, [3, 1]);
  assert.deepEqual(hidden, [2]);
  // 面板实际取的行序：只来自当前可见行
  assert.deepEqual(visibleReorderIds([{ itemId: 3 }, { itemId: 1 }]), [3, 1]);
});

test("证据列文案固定；冲突提示只在清单声明超出证据时出现且写明不会自动改写", () => {
  assert.equal(evidenceLabel("registered"), "工程登记");
  assert.equal(evidenceLabel("referenced"), "实际引用");
  assert.equal(evidenceLabel("verified"), "导入校验");
  assert.equal(evidenceMark(true), "✓");
  assert.equal(evidenceMark(false), "—");

  const ev = (o: Partial<LoadoutItem["evidence"]> = {}): LoadoutItem["evidence"] => ({
    registered: false, referenced: false, verified: false,
    registeredAt: null, referencedAt: null, verifiedAt: null, ...o,
  });
  // 正例：证据支持声明 → 不提示
  assert.equal(conflictHint("imported", ev({ registered: true })), "");
  assert.equal(conflictHint("verified", ev({ verified: true })), "");
  // 反例：声明「已导入/已验证」但证据缺失 → 提示，且不改写
  assert.match(conflictHint("imported", ev()), /清单声明与工程证据不一致（不会自动改写）/);
  assert.match(conflictHint("verified", ev({ registered: true })), /不一致/);
  // planned 只是「准备使用」，没有声明，不构成冲突
  assert.equal(conflictHint("planned", ev()), "");
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

function loadout(overrides: Partial<Loadout> = {}): Loadout {
  return {
    id: 9, avatarId: 4, name: "默认清单", note: null, sort: 0,
    itemCount: 1, stateCounts: { planned: 1, imported: 0, verified: 0 }, trashedCount: 0,
    updatedAt: "2026-11-04T02:00:00.000Z", version: 3, createdAt: "2026-11-04T01:00:00.000Z",
    ...overrides,
  };
}

function item(overrides: Partial<LoadoutItem> = {}): LoadoutItem {
  return {
    itemId: 7, state: "planned", note: null, position: 0, version: 2,
    createdAt: "2026-11-04T01:00:00.000Z", updatedAt: "2026-11-04T02:00:00.000Z",
    evidence: { registered: false, referenced: false, verified: false, registeredAt: null, referencedAt: null, verifiedAt: null },
    item: {
      id: 7, title: "示例条目", sourceSite: "booth", sourceItemId: "1", sourceUrl: null, shopName: null,
      // ItemCard.favorite/adult 是 number 0/1（contracts.ts:159），不是 boolean；不用 as 断言弱化契约。
      status: "active", favorite: 0, adult: 0, coverImageId: null, coverUrl: null,
      imageCount: 0, assetCount: 0, totalBytes: 0, avatars: [], tags: [], compatDeclaredCount: 0,
      collections: [], category: null, suggestion: null, updatedAt: "2026-11-04T02:00:00.000Z",
    },
    ...overrides,
  };
}

function detail(overrides: Partial<LoadoutDetail> = {}): LoadoutDetail {
  return {
    loadout: loadout(), total: 1,
    stateCounts: { planned: 1, imported: 0, verified: 0 },
    visibleStateCounts: { planned: 1, imported: 0, verified: 0 },
    trashedCount: 0, items: [item()], ...overrides,
  };
}

test("9 个搭配端点的 method/URL/body 与 CAS expectedVersion", async () => {
  const stub = stubFetch((call) => {
    if (call.url.startsWith("/api/avatars/")) {
      return call.method === "GET" ? json({ loadouts: [loadout()] }) : json({ loadout: loadout() }, 201);
    }
    if (call.url.endsWith("/items/reorder")) return json({ items: [item()] });
    if (call.url.endsWith("/items")) return json({ added: 1, revived: 0, existing: 0, items: [item()] });
    if (call.url.includes("/items/")) {
      if (call.method === "DELETE") return json({ removed: 1 });
      return json({ item: item() });
    }
    if (call.method === "GET") return json(detail());
    if (call.method === "DELETE") return json({ deleted: true });
    return json({ loadout: loadout() });
  });
  try {
    const listed = await listAvatarLoadouts(4);
    assert.equal(stub.calls[0].method, "GET");
    assert.equal(stub.calls[0].url, "/api/avatars/4/loadouts");
    assert.equal(listed.loadouts[0].id, 9);

    const created = await createLoadout(4, { name: "默认清单", note: null });
    assert.equal(stub.calls[1].method, "POST");
    assert.equal(stub.calls[1].url, "/api/avatars/4/loadouts");
    assert.deepEqual(stub.calls[1].body, { name: "默认清单", note: null });
    assert.equal(created.loadout.version, 3);

    const got = await getLoadout(9, { includeTrashedItems: true });
    assert.equal(stub.calls[2].method, "GET");
    assert.equal(stub.calls[2].url, "/api/loadouts/9?includeTrashedItems=1");
    assert.equal(got.total, 1);
    assert.equal(got.items[0].itemId, 7);

    const renamed = await patchLoadout(9, { name: "改名", expectedVersion: 3 });
    assert.equal(stub.calls[3].method, "PATCH");
    assert.equal(stub.calls[3].url, "/api/loadouts/9");
    assert.deepEqual(stub.calls[3].body, { name: "改名", expectedVersion: 3 });
    assert.equal(renamed.loadout.id, 9);

    const added = await addLoadoutItems(9, { itemIds: [7], state: "planned" });
    assert.equal(stub.calls[4].method, "POST");
    assert.equal(stub.calls[4].url, "/api/loadouts/9/items");
    assert.deepEqual(stub.calls[4].body, { itemIds: [7], state: "planned" });
    assert.equal(added.added, 1);

    const reordered = await reorderLoadoutItems(9, [3, 1]);
    assert.equal(stub.calls[5].method, "POST");
    assert.equal(stub.calls[5].url, "/api/loadouts/9/items/reorder");
    assert.deepEqual(stub.calls[5].body, { itemIds: [3, 1] });
    assert.equal(reordered.items.length, 1);

    const patched = await patchLoadoutItem(9, 7, { state: "verified", expectedVersion: 2 });
    assert.equal(stub.calls[6].method, "PATCH");
    assert.equal(stub.calls[6].url, "/api/loadouts/9/items/7");
    assert.deepEqual(stub.calls[6].body, { state: "verified", expectedVersion: 2 });
    assert.equal(patched.item.itemId, 7);

    const removed = await removeLoadoutItem(9, 7);
    assert.equal(stub.calls[7].method, "DELETE");
    assert.equal(stub.calls[7].url, "/api/loadouts/9/items/7");
    assert.equal(removed.removed, 1);

    const deleted = await deleteLoadout(9);
    assert.equal(stub.calls[8].method, "DELETE");
    assert.equal(stub.calls[8].url, "/api/loadouts/9");
    assert.equal(deleted.deleted, true);
  } finally { stub.restore(); }
});

test("409 清单/清单项 CAS 冲突把 details.code 原样带出", async () => {
  const stub = stubFetch(() => json({
    error: { code: "CONFLICT", message: "清单项已被修改（expectedVersion 过期）", details: { code: "LOADOUT_ITEM_VERSION_CONFLICT" } },
  }, 409));
  try {
    await assert.rejects(patchLoadoutItem(9, 7, { state: "verified", expectedVersion: 1 }), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "CONFLICT");
      assert.equal(err.details?.code, "LOADOUT_ITEM_VERSION_CONFLICT");
      return true;
    });
  } finally { stub.restore(); }
});

// ---------------- 源码接线静态门（AST；不是 DOM 执行） ----------------

const PANEL_PATH = fileURLToPath(new URL("../../apps/web/src/components/LoadoutPanel.tsx", import.meta.url));
const BUTTON_PATH = fileURLToPath(new URL("../../apps/web/src/components/AddToLoadoutButton.tsx", import.meta.url));

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

function calledNames(node: ts.Node): string[] {
  const out: string[] = [];
  walk(node, (n) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) out.push(n.expression.text); });
  return out;
}

function callArgs(sf: ts.SourceFile, name: string): ts.NodeArray<ts.Expression>[] {
  const out: ts.NodeArray<ts.Expression>[] = [];
  walk(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) out.push(n.arguments);
  });
  return out;
}

test("面板接到真实清单/条目端点；拖拽只提交可见行（hiddenIds=[]），不加未准 state 筛选", () => {
  const sf = astOf(PANEL_PATH);
  const imports = apiImports(sf);
  for (const fn of ["listAvatarLoadouts", "createLoadout", "getLoadout", "patchLoadout", "deleteLoadout", "patchLoadoutItem", "removeLoadoutItem", "reorderLoadoutItems"]) {
    assert.ok(imports.includes(fn), "LoadoutPanel 未从 ../api 导入 " + fn);
  }
  const text = readFileSync(PANEL_PATH, "utf8");
  assert.ok(text.includes("只删清单，不删素材"), "删除确认必须写明只删清单不删素材");
  assert.ok(text.includes("显示回收站"), "必须有回收站开关");
  assert.ok(text.includes("清单声明与工程证据不一致（不会自动改写）") || text.includes("conflictHint"), "必须接冲突提示");

  // 拖拽：reorderPayload(visibleIds, []) —— 第二个实参必须是空数组字面量，不能先加载隐藏行
  const calls = callArgs(sf, "reorderPayload");
  assert.equal(calls.length, 1, "reorderPayload 应只有一处调用");
  assert.equal(calls[0].length, 2, "reorderPayload 必须显式传 hiddenIds");
  const hidden = calls[0][1];
  assert.ok(ts.isArrayLiteralExpression(hidden) && hidden.elements.length === 0, "面板只提交可见行：hiddenIds 必须是 []");

  // 不加未准 state 筛选：getLoadout 的选项对象里不得出现 state 属性
  for (const args of callArgs(sf, "getLoadout")) {
    const opts = args[1];
    if (!opts || !ts.isObjectLiteralExpression(opts)) continue;
    for (const p of opts.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) assert.notEqual(p.name.text, "state", "面板不得加未准 state 筛选");
    }
  }
});

test("加入按钮按用户显式选择模型→清单→添加；不读 item_avatars、不在挂载时自动 POST", () => {
  const sf = astOf(BUTTON_PATH);
  const imports = apiImports(sf);
  assert.ok(imports.includes("addLoadoutItems"), "AddToLoadoutButton 未导入 addLoadoutItems");
  assert.ok(imports.includes("listAvatarLoadouts"), "AddToLoadoutButton 未导入 listAvatarLoadouts");
  const text = readFileSync(BUTTON_PATH, "utf8");
  assert.ok(text.includes("加入搭配清单"), "按钮文案必须是「加入搭配清单…」");
  // 不自动从 item_avatars 填充：源码不得出现 item_avatars / 条目 avatars 字段
  assert.equal(/item_avatars/.test(text), false, "不得引用 item_avatars");
  assert.equal(/\.avatars\b/.test(text), false, "不得读条目 avatars 自动选模型");
  // 只有一处 addLoadoutItems 调用（用户点击后），且不在 useEffect 里
  assert.equal(calledNames(sf).filter((c) => c === "addLoadoutItems").length, 1, "addLoadoutItems 应只有一处调用");
  let inEffect = 0;
  walk(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "useEffect") {
      for (const a of n.arguments) if (calledNames(a).includes("addLoadoutItems")) inEffect += 1;
    }
  });
  assert.equal(inEffect, 0, "挂载/依赖变化时不得自动 POST");
});

// ---------------- 真实 handler 体执行（TS 去类型 + 注入依赖；不是 DOM 执行） ----------------
// Ruling24：用真实 handler 函数体 + 关闭的依赖桩验证行为边界，不以静态标签/无接线模型当行为证据。
// 能力边界：这里执行的是从 LoadoutPanel.tsx 抽出的真实函数体，不是 React 渲染/事件系统。

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

test("删除当前选中清单：不重载已删 id 的详情、清空选择/详情/错误、刷新列表与回调", async () => {
  const sf = astOf(PANEL_PATH);
  const calls: string[] = [];
  const state: Record<string, unknown> = {};
  const factory = buildHandler(sf, "removeLoadout", [
    "deleteLoadout", "toast", "setSelectedId", "setDetail", "setError", "loadList", "loadDetail",
    "props", "selectedId", "setBusy", "setConfirmDelete", "describeError", "run",
  ]);
  const props = { onChanged: () => calls.push("onChanged") };
  const handler = factory(
    (id: number) => { calls.push("delete:" + id); return Promise.resolve({ deleted: true }); },
    (kind: string, text: string) => calls.push("toast:" + kind + ":" + text),
    (v: unknown) => { state.selectedId = v; calls.push("setSelectedId:" + String(v)); },
    (v: unknown) => { state.detail = v; calls.push("setDetail:" + String(v)); },
    (v: unknown) => { state.error = v; calls.push("setError:" + String(v)); },
    () => calls.push("loadList"),
    () => calls.push("loadDetail"),
    props,
    9,
    (v: unknown) => calls.push("setBusy:" + String(v)),
    (v: unknown) => calls.push("setConfirmDelete:" + String(v)),
    (e: unknown) => "ERR:" + String(e),
    // 旧实现的通用 run：成功后会 loadList + loadDetail（正是要消除的 stale 重载）
    (key: string, pr: Promise<unknown>, okText: string, after?: () => void) => {
      calls.push("run:" + key);
      pr.then(() => { calls.push("toast:" + okText); after?.(); calls.push("loadList"); calls.push("loadDetail"); props.onChanged?.(); });
    },
  );

  await handler({ id: 9, name: "默认清单" });
  await flush();

  assert.ok(calls.includes("delete:9"), "必须真的调用 deleteLoadout(9)");
  assert.equal(calls.includes("loadDetail"), false, "删除后不得用旧 selectedId 重载详情（会 GET 已删 id → 404）");
  assert.equal(state.selectedId, null, "删除选中清单后选择必须清空");
  assert.equal(state.detail, null, "删除后详情必须清空");
  assert.equal(state.error, "", "清空选择时必须清掉旧错误横幅");
  assert.ok(calls.includes("loadList"), "删除后必须刷新清单列表");
  assert.ok(calls.includes("onChanged"), "删除后必须回调父刷新");
  assert.ok(calls.some((c) => c.startsWith("toast:ok:") && c.includes("只删清单，不删素材")), "保留删除成功文案");
});

test("截断时拖拽不 POST；100/101/500 完整行可排、501/500 截断不可排", () => {
  const sf = astOf(PANEL_PATH);
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ itemId: i + 1 }));

  const runCase = (total: number, shown: number) => {
    const calls: string[] = [];
    const factory = buildHandler(sf, "dropOn", [
      "detail", "dragId", "setDragId", "visibleReorderIds", "reorderPayload", "reorderLoadoutItems", "run", "toast",
    ]);
    const handler = factory(
      { loadout: { id: 9 }, total, items: rows(shown) },
      1,
      (v: unknown) => calls.push("setDragId:" + String(v)),
      visibleReorderIds,
      reorderPayload,
      (id: number, ids: number[]) => { calls.push("reorder:" + id + ":" + ids.length); return Promise.resolve({ items: [] }); },
      (key: string) => calls.push("run:" + key),
      (kind: string, text: string) => calls.push("toast:" + kind + ":" + text),
    );
    handler(2);
    return calls;
  };

  // 完整返回：可排（101 行全返回也合法）
  for (const n of [100, 101, 500]) {
    const calls = runCase(n, n);
    assert.ok(calls.includes("reorder:9:" + n), n + " 行完整返回时必须提交 " + n + " 个可见 id");
  }
  // 截断：501 行只返回 500 → 不得 POST（server 会判 400 INVALID_INPUT）
  const truncated = runCase(501, 500);
  assert.equal(truncated.some((c) => c.startsWith("reorder:")), false, "截断时不得 POST reorder");
  assert.ok(truncated.some((c) => c.startsWith("toast:bad:")), "截断时必须提示，不能静默失败");
});

test("详情请求带 limit=500；draggable 属性受截断门控制（静态补充，非运行时）", () => {
  const sf = astOf(PANEL_PATH);
  const calls = callArgs(sf, "getLoadout");
  assert.ok(calls.length >= 1, "必须调用 getLoadout");
  const opts = calls[0][1];
  assert.ok(opts && ts.isObjectLiteralExpression(opts), "getLoadout 必须带选项对象");
  const limit = opts.properties.find((pr) => ts.isPropertyAssignment(pr) && ts.isIdentifier(pr.name) && pr.name.text === "limit");
  assert.ok(limit && ts.isPropertyAssignment(limit), "getLoadout 必须显式传 limit");
  assert.equal(limit.initializer.getText(sf), "500", "limit 必须是已准上限 500");

  let draggableExpr = "";
  walk(sf, (n) => {
    if (ts.isJsxAttribute(n) && ts.isIdentifier(n.name) && n.name.text === "draggable" && n.initializer && ts.isJsxExpression(n.initializer)) {
      draggableExpr = n.initializer.expression?.getText(sf) ?? "";
    }
  });
  assert.ok(draggableExpr, "条目行必须有 draggable 属性");
  assert.ok(/truncated|canReorder/.test(draggableExpr), "draggable 必须受截断门控制，实得：" + draggableExpr);
});

