/**
 * 预检卡纯函数（P2-T5 brief Step 1）。
 *
 * 固定文案来自 spec §8.1：弱提示必须写明"不是精确重复"，版本候选必须写明"未证实"，
 * 禁止出现"已验证版本 / 确认是新版本 / 实时磁盘检查"。
 * 另测 expected 构造：缺 size/mtime 的行不得伪造 expected（服务端 EXPECTED_REQUIRED 是结构性保证）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { PrecheckResult, VersionLink } from "../../apps/web/src/types";
import { acceptedFileOf, expectedOf, summaryLabel, summaryPriority, warningText } from "../../apps/web/src/precheck-view";
import {
  ApiError, commitStage, createVersionLink, deleteVersionLink, importAcceptedFiles, listVersionLinks,
  patchVersionLink, precheckPaths, stageDownload,
} from "../../apps/web/src/api";

const EMPTY_MATCH: PrecheckResult["match"] = {
  exact: null, sameProduct: null, version: null, companion: null, weak: null, pathCollision: null,
};

function result(overrides: Partial<PrecheckResult> = {}): PrecheckResult {
  return {
    path: "C:/Downloads/a.zip",
    pathNorm: "c:/downloads/a.zip",
    group: { rootPath: "C:/Downloads", rootId: 1 },
    size: 123,
    mtime: "2026-11-04T02:00:00.000Z",
    hash: { state: "ok", sha256: "a".repeat(64) },
    match: EMPTY_MATCH,
    summary: "none",
    warnings: [],
    ...overrides,
  };
}

test("标签与优先级固定；弱提示必须写明不是精确重复", () => {
  assert.equal(summaryLabel("exact"), "精确重复（字节相同）");
  assert.equal(summaryLabel("version-candidate"), "同商品，可能是新版本（未证实）");
  assert.ok(summaryPriority("exact") > summaryPriority("version-candidate"));
  assert.ok(summaryPriority("version-candidate") > summaryPriority("same-product"));
  assert.equal(
    warningText(result({ match: { ...EMPTY_MATCH, weak: { reason: "name_size_hint" } } })),
    "弱提示：同名同尺寸（不是精确重复）",
  );
});

test("其余标签与 spec §6.1 的优先级顺序一致", () => {
  assert.equal(summaryLabel("companion-candidate"), "同商品，可能是配套文件（未证实）");
  assert.equal(summaryLabel("same-product"), "同商品");
  assert.equal(summaryLabel("pathCollision"), "路径已属于其它条目");
  assert.equal(summaryLabel("weak"), "弱提示（不是精确重复）");
  assert.equal(summaryLabel("unknown"), "未知（哈希失败/超预算/已取消）");
  assert.equal(summaryLabel("none"), "未发现重复");
  // spec §6.1：exact > version-candidate > companion-candidate > same-product > pathCollision > weak > unknown > none
  const order: PrecheckResult["summary"][] = [
    "exact", "version-candidate", "companion-candidate", "same-product", "pathCollision", "weak", "unknown", "none",
  ];
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(summaryPriority(order[i - 1]) > summaryPriority(order[i]), order[i - 1] + " 应高于 " + order[i]);
  }
});

test("弱提示四种原因都写明不是精确重复；无弱提示时回落到 warnings", () => {
  for (const reason of ["existing_hash_stale", "existing_hash_unverified", "existing_hash_mismatch", "name_size_hint"] as const) {
    const text = warningText(result({ match: { ...EMPTY_MATCH, weak: { reason } } }));
    assert.ok(text.includes("不是精确重复"), reason + " 文案缺「不是精确重复」：" + text);
  }
  assert.equal(warningText(result({ warnings: ["预算不足", "已取消"] })), "预算不足；已取消");
  assert.equal(warningText(result()), "");
});

test("expected 只取真实 size/mtime；缺字段或哈希未知时不伪造", () => {
  assert.deepEqual(expectedOf(result()), { size: 123, mtime: "2026-11-04T02:00:00.000Z", sha256: "a".repeat(64) });
  // 哈希未知 → 不带 sha256（只比 size+mtime，服务端记 verified:"metadata"）
  assert.deepEqual(expectedOf(result({ hash: { state: "unknown", reason: "budget_exceeded" } })), {
    size: 123, mtime: "2026-11-04T02:00:00.000Z",
  });
  // 失败行没有 size/mtime → null，不假造 0 / 空串
  assert.equal(expectedOf(result({ size: null as unknown as number })), null);
  assert.equal(expectedOf(result({ mtime: null as unknown as string })), null);
  assert.equal(expectedOf(result({ mtime: "" })), null);
});

test("acceptedFileOf 只带当前文件与 group，不带原目录 paths", () => {
  const f = acceptedFileOf(result());
  assert.ok(f);
  assert.equal(f.path, "C:/Downloads/a.zip");
  assert.deepEqual(f.group, { rootPath: "C:/Downloads", rootId: 1 });
  assert.equal("paths" in f, false);
  assert.equal(acceptedFileOf(result({ size: null as unknown as number })), null);
});

// ---------------- 本模块 typed API 调用（关闭网络 fetch stub；不发真实 HTTP） ----------------

interface StubCall { url: string; method: string; body: unknown }

/** 关闭网络的 fetch stub：记录 method/url/JSON body，responder 决定响应。 */
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

function link(overrides: Partial<VersionLink> = {}): VersionLink {
  return {
    id: 9,
    assetAId: 3,
    assetBId: 5,
    relation: "a_newer",
    basis: "manual",
    state: "candidate",
    evidence: null,
    version: 3,
    createdAt: "2026-11-04T02:00:00.000Z",
    updatedAt: "2026-11-04T02:00:00.000Z",
    decidedAt: null,
    assets: {
      a: { id: 3, path: "C:/lib/a_v1.zip", size: 10, mtime: "2026-11-04T01:00:00.000Z" },
      b: { id: 5, path: "C:/lib/a_v2.zip", size: 20, mtime: "2026-11-04T01:30:00.000Z" },
    },
    ...overrides,
  };
}

test("precheckPaths 走 POST /api/import/precheck，body 只带 paths", async () => {
  const stub = stubFetch(() => json({ checkedAt: "2026-11-04T03:00:00.000Z", budget: { maxBytes: 1, maxMs: 1, usedBytes: 0, usedMs: 0, truncated: false }, results: [] }));
  try {
    const res = await precheckPaths({ paths: ["C:/Downloads/a.zip"] });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].method, "POST");
    assert.equal(stub.calls[0].url, "/api/import/precheck");
    assert.deepEqual(stub.calls[0].body, { paths: ["C:/Downloads/a.zip"] });
    assert.equal(res.results.length, 0);
  } finally { stub.restore(); }
});

test("importAcceptedFiles 只发当前接受 files（带 expected/group），不发原目录 paths", async () => {
  const stub = stubFetch(() => json({ jobIds: [11, 12], duplicates: [], legacy: false }));
  try {
    const res = await importAcceptedFiles([
      { path: "C:/Downloads/a.zip", expected: { size: 123, mtime: "2026-11-04T02:00:00.000Z", sha256: "a".repeat(64) }, group: { rootPath: "C:/Downloads", rootId: 1 } },
      { path: "C:/Downloads/c.zip", expected: { size: 456, mtime: "2026-11-04T02:00:01.000Z" } },
    ]);
    const body = stub.calls[0].body as { files?: unknown[]; paths?: unknown };
    assert.equal(stub.calls[0].url, "/api/import/paths");
    assert.equal("paths" in body, false);
    assert.deepEqual(body.files, [
      { path: "C:/Downloads/a.zip", expected: { size: 123, mtime: "2026-11-04T02:00:00.000Z", sha256: "a".repeat(64) }, group: { rootPath: "C:/Downloads", rootId: 1 } },
      { path: "C:/Downloads/c.zip", expected: { size: 456, mtime: "2026-11-04T02:00:01.000Z" } },
    ]);
    assert.deepEqual(res.jobIds, [11, 12]);
  } finally { stub.restore(); }
});

test("stageDownload 固定 stage=true，不回传 stagedPath；legacy 响应不冒充 stage", async () => {
  const precheck = { checkedAt: "2026-11-04T03:00:00.000Z", budget: { maxBytes: 1, maxMs: 1, usedBytes: 0, usedMs: 0, truncated: false }, results: [] };
  const stub = stubFetch(() => json({ staged: true, stageToken: "tok-1", bytes: 12, fileName: "a.zip", precheck }));
  try {
    const res = await stageDownload({ url: "https://booth.pm/downloadables/1", itemId: "6115428" });
    const body = stub.calls[0].body as Record<string, unknown>;
    assert.equal(stub.calls[0].url, "/api/import/download");
    assert.equal(body.stage, true);
    assert.equal(body.url, "https://booth.pm/downloadables/1");
    assert.equal("stagedPath" in body, false);
    assert.equal(res.staged, true);
    assert.equal(res.stageToken, "tok-1");
    assert.equal(res.bytes, 12);
    assert.equal(res.fileName, "a.zip");
    assert.equal(res.precheck.results.length, 0);
  } finally { stub.restore(); }

  const legacy = stubFetch(() => json({ itemId: 1, path: "C:/dl/a.zip", bytes: 12, fileName: "a.zip", jobId: 3 }));
  try {
    await assert.rejects(stageDownload({ url: "https://booth.pm/downloadables/1" }), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, "UPSTREAM_ERROR");
      assert.ok(err.message.includes("stage"));
      return true;
    });
  } finally { legacy.restore(); }
});

test("commitStage 公开 body 只有 stageToken/decision（无 token、无 stagedPath）", async () => {
  const stub = stubFetch(() => json({ replayed: false, decision: "import", itemId: 4, assetId: 6 }));
  try {
    const res = await commitStage("tok-1", "import");
    assert.equal(stub.calls[0].url, "/api/import/download/commit");
    assert.deepEqual(Object.keys(stub.calls[0].body as Record<string, unknown>).sort(), ["decision", "stageToken"]);
    assert.deepEqual(stub.calls[0].body, { stageToken: "tok-1", decision: "import" });
    assert.equal(res.decision, "import");
    assert.equal(res.itemId, 4);
    assert.equal(res.assetId, 6);
  } finally { stub.restore(); }
});

test("版本关系 CRUD 的 method/URL/body 与 CAS expectedVersion", async () => {
  const stub = stubFetch((call) => {
    if (call.method === "GET") return json({ itemId: 7, total: 1, links: [link()] });
    if (call.method === "DELETE") return json({ deleted: true });
    return json(link());
  });
  try {
    const listed = await listVersionLinks(7, { state: "candidate", limit: 50 });
    assert.equal(stub.calls[0].method, "GET");
    assert.equal(stub.calls[0].url, "/api/items/7/version-links?state=candidate&limit=50");
    assert.equal(listed.total, 1);
    assert.equal(listed.links[0].assets.b.path, "C:/lib/a_v2.zip");

    const created = await createVersionLink(7, { assetAId: 3, assetBId: 5, relation: "a_newer", basis: "manual" });
    assert.equal(stub.calls[1].method, "POST");
    assert.equal(stub.calls[1].url, "/api/items/7/version-links");
    assert.deepEqual(stub.calls[1].body, { assetAId: 3, assetBId: 5, relation: "a_newer", basis: "manual" });
    assert.equal(created.state, "candidate");

    const patched = await patchVersionLink(7, 9, { state: "confirmed", expectedVersion: 3 });
    assert.equal(stub.calls[2].method, "PATCH");
    assert.equal(stub.calls[2].url, "/api/items/7/version-links/9");
    assert.deepEqual(stub.calls[2].body, { state: "confirmed", expectedVersion: 3 });
    assert.equal(patched.version, 3);

    const removed = await deleteVersionLink(7, 9);
    assert.equal(stub.calls[3].method, "DELETE");
    assert.equal(stub.calls[3].url, "/api/items/7/version-links/9");
    assert.equal(removed.deleted, true);
  } finally { stub.restore(); }
});

test("409 版本冲突把 details.code 原样带出（VERSION_CONFLICT）", async () => {
  const stub = stubFetch(() => json({ error: { code: "CONFLICT", message: "版本关系已被修改（expectedVersion 过期）", details: { code: "VERSION_CONFLICT" } } }, 409));
  try {
    await assert.rejects(patchVersionLink(7, 9, { state: "confirmed", expectedVersion: 2 }), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "CONFLICT");
      assert.equal(err.details?.code, "VERSION_CONFLICT");
      return true;
    });
  } finally { stub.restore(); }
});

// ---------------- 旧入口接线静态门（无 DOM 能力：AST 静态检查，不是浏览器/handler 执行） ----------------
// Ruling18：旧「本地路径导入」按钮曾直接调 importPaths 发 legacy {paths}，绕过预检/expected。
// 这里只证明源码接线（导入/调用/按钮目标），不声称已执行 React 事件；真实 UI 行为留 P1-T5。

const PANEL_PATH = fileURLToPath(new URL("../../apps/web/src/components/ImportPanel.tsx", import.meta.url));

function panelAst(): ts.SourceFile {
  const text = readFileSync(PANEL_PATH, "utf8");
  return ts.createSourceFile(PANEL_PATH, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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

function functionBody(sf: ts.SourceFile, name: string): ts.Node | null {
  let found: ts.Node | null = null;
  walk(sf, (n) => {
    if (found) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) found = n.body;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) found = n.initializer;
  });
  return found;
}

function calledNames(node: ts.Node): string[] {
  const out: string[] = [];
  walk(node, (n) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) out.push(n.expression.text); });
  return out;
}

test("旧本地路径导入入口不得再发 legacy {paths}（AST 静态门，非浏览器执行）", () => {
  const sf = panelAst();
  assert.equal(apiImports(sf).includes("importPaths"), false, "ImportPanel 仍从 ../api 导入 legacy importPaths");
  const ids: string[] = [];
  walk(sf, (n) => { if (ts.isIdentifier(n)) ids.push(n.text); });
  assert.equal(ids.includes("importPaths"), false, "ImportPanel 仍引用 legacy importPaths");
  assert.equal(ids.includes("doImportPaths"), false, "ImportPanel 仍保留 doImportPaths handler");
  // 正例：唯一提交入口是 files+expected（importAcceptedFiles 由 acceptedFileOf 构造）
  assert.equal(calledNames(sf).filter((c) => c === "importAcceptedFiles").length, 1, "应只有一处 importAcceptedFiles 调用");
  assert.ok(ids.includes("acceptedFileOf"), "接受列表必须由 acceptedFileOf 构造（带 expected）");
  assert.ok(ids.includes("precheckPaths"), "预检入口必须存在");
});

test("本地路径区按钮接到预检；form/dragdrop 只收集路径不发导入（AST 静态门）", () => {
  const sf = panelAst();
  const ids: string[] = [];
  walk(sf, (n) => { if (ts.isIdentifier(n)) ids.push(n.text); });
  assert.ok(ids.includes("doPrecheck"), "本地路径区必须有接到 doPrecheck 的按钮");
  const pre = functionBody(sf, "doPrecheck");
  assert.ok(pre, "doPrecheck 必须存在");
  assert.ok(calledNames(pre!).includes("precheckPaths"), "doPrecheck 必须调用 precheckPaths");

  // form/dragdrop：handleFiles/onDrop 只收集路径，不得调用任何 ../api 导入函数
  const apiNames = new Set(apiImports(sf));
  for (const fn of ["handleFiles", "onDrop"]) {
    const body = functionBody(sf, fn);
    assert.ok(body, fn + " 必须存在");
    const leaked = calledNames(body!).filter((c) => apiNames.has(c));
    assert.deepEqual(leaked, [], fn + " 直接调用了 API：" + leaked.join(","));
  }
});

test("正例：acceptedFileOf → importAcceptedFiles 只发 files（带 expected），不发 paths", async () => {
  const stub = stubFetch(() => json({ jobIds: [21], duplicates: [], legacy: false }));
  try {
    const file = acceptedFileOf(result({ path: "C:/Downloads/new.zip", pathNorm: "c:/downloads/new.zip" }));
    assert.ok(file);
    await importAcceptedFiles([file]);
    const body = stub.calls[0].body as { files?: Array<{ path: string; expected: unknown }>; paths?: unknown };
    assert.equal("paths" in body, false);
    assert.equal(body.files?.length, 1);
    assert.equal(body.files?.[0].path, "C:/Downloads/new.zip");
    assert.deepEqual(body.files?.[0].expected, { size: 123, mtime: "2026-11-04T02:00:00.000Z", sha256: "a".repeat(64) });
  } finally { stub.restore(); }
});

