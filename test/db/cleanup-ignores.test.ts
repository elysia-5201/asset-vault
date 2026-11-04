/**
 * 整理待办：忽略/resolved 与保存筛选（cleanup-todos spec §6.2/§6.3，P4-T2）。
 *
 * 全部用临时 SQLite fixture（test/schema/_db.ts 建真实 schema.sql），不碰生产库/素材/7317。
 * 口径：resolved 按 (item, rule) 单条求值，不套基础范围；管理列表独立于待办派生。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { openTempDb, addItem, addAvatar, addImage, count, NOW, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import {
  listCleanupTodos, listCleanupIgnores, upsertCleanupIgnore, deleteCleanupIgnore,
  listCleanupFilters, createCleanupFilter, patchCleanupFilter, deleteCleanupFilter,
  validateCleanupFilter, mergeCleanupIgnoresTx,
  type CleanupFilter,
} from "../../apps/server/src/db/cleanup";

const isInvalidInput = (e: unknown): boolean => (e as { code?: string })?.code === "INVALID_INPUT";
const isLocalPolicyRequired = (e: unknown): boolean => {
  const err = e as { code?: string; details?: { code?: string } };
  return err?.code === "INVALID_INPUT" && err?.details?.code === "LOCAL_POLICY_REQUIRED";
};
const isConflict = (e: unknown): boolean => (e as { code?: string })?.code === "CONFLICT";
const isNotFound = (e: unknown): boolean => (e as { code?: string })?.code === "NOT_FOUND";

const linkAvatar = (db: TempDb["db"], itemId: number, avatarId: number, match = "any") =>
  db.prepare("INSERT INTO item_avatars(item_id,avatar_id,match,confidence,source) VALUES (?,?,?,1,'manual')").run(itemId, avatarId, match);

const ignore = (db: TempDb["db"], itemId: number, rule: string, note: string | null = null, at = NOW) =>
  db.prepare("INSERT INTO cleanup_ignores(item_id,rule,note,ignored_at) VALUES (?,?,?,?)").run(itemId, rule, note, at);

test("忽略粘性、resolved 随策略变化、ignored=only 口径", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const local = addItem(t.db, { title: "local", source_site: "local" });
  addImage(t.db, local);
  const av = addAvatar(t.db, "A"); linkAvatar(t.db, local, av);
  assert.equal(listCleanupTodos(repo, { q: "' OR 1=1 --", localSourcePolicy: "include_local" }).total, 0);
  const before = t.db.prepare("SELECT * FROM items WHERE id=?").get(local);
  const created = upsertCleanupIgnore(repo, { itemId: local, rule: "missing_source" });
  assert.equal(created.itemId, local);
  assert.equal(created.rule, "missing_source");
  assert.equal(created.resolved, false);
  assert.deepEqual(t.db.prepare("SELECT * FROM items WHERE id=?").get(local), before);
  assert.equal(listCleanupTodos(repo, { localSourcePolicy: "include_local" }).items.length, 0);
  const only = listCleanupTodos(repo, { localSourcePolicy: "include_local", ignored: "only" });
  assert.equal(only.total, 1);
  assert.equal(only.items[0]?.resolved, false);
  assert.equal(only.counts.missing_source.total, 1);
  const exc = listCleanupIgnores(repo, { localSourcePolicy: "exclude_local" });
  assert.equal(exc.total, 1);
  assert.equal(exc.ignores[0]?.resolved, true);
  assert.equal(deleteCleanupIgnore(repo, local, "missing_source").removed, 1);
  assert.equal(deleteCleanupIgnore(repo, local, "missing_source").removed, 0);
  t.close();
});

test("保存筛选严格校验：未知键/缺策略 400、q 参数化", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  assert.throws(() => validateCleanupFilter({ includeArchived: true, localSourcePolicy: "include_local" }), isInvalidInput);
  assert.throws(() => validateCleanupFilter({ includeTrashed: true, localSourcePolicy: "include_local" }), isInvalidInput);
  assert.throws(() => validateCleanupFilter({ rule: "missing_cover" }), isLocalPolicyRequired);
  assert.throws(() => validateCleanupFilter({ localSourcePolicy: "bogus" }), isLocalPolicyRequired);
  assert.throws(() => validateCleanupFilter({ localSourcePolicy: "include_local", rule: "bogus" }), isInvalidInput);
  assert.throws(() => validateCleanupFilter({ localSourcePolicy: "include_local", limit: 0 }), isInvalidInput);
  assert.throws(() => validateCleanupFilter({ localSourcePolicy: "include_local", limit: 201 }), isInvalidInput);
  assert.throws(() => validateCleanupFilter({ localSourcePolicy: "include_local", avatarIds: [1, "2"] }), isInvalidInput);
  assert.throws(() => validateCleanupFilter({ localSourcePolicy: "include_local", q: "x".repeat(201) }), isInvalidInput);
  const f = createCleanupFilter(repo, { name: "f1", filter: validateCleanupFilter({ localSourcePolicy: "include_local", q: "' OR 1=1 --" }) });
  assert.equal(f.version, 1);
  assert.equal(f.filter.q, "' OR 1=1 --");
  assert.equal(count(t.db, "cleanup_saved_filters"), 1);
  assert.equal(listCleanupTodos(repo, { ...f.filter }).total, 0, "注入串必须参数化");
  t.close();
});

test("管理列表独立：archived/trashed 可见，todos ignored=only 仍排除", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const av = addAvatar(t.db, "A");
  const active = addItem(t.db, { title: "active", source_url: "https://x", status: "active" }); linkAvatar(t.db, active, av);
  const archived = addItem(t.db, { title: "archived", source_url: "https://x", status: "archived" }); linkAvatar(t.db, archived, av);
  const trashed = addItem(t.db, { title: "trashed", source_url: "https://x", status: "trashed" }); linkAvatar(t.db, trashed, av);
  ignore(t.db, active, "missing_cover"); ignore(t.db, archived, "missing_cover"); ignore(t.db, trashed, "missing_cover");
  const only = listCleanupTodos(repo, { localSourcePolicy: "include_local", ignored: "only" });
  assert.deepEqual(only.items.map((x) => x.item.id), [active]);
  const mgmt = listCleanupIgnores(repo, { localSourcePolicy: "include_local" });
  assert.equal(mgmt.total, 3);
  assert.deepEqual(mgmt.ignores.map((x) => x.item.status).sort(), ["active", "archived", "trashed"]);
  assert.ok(mgmt.ignores.every((x) => x.resolved === false), "归档/回收站本身不算问题已解决");
  const page = listCleanupIgnores(repo, { localSourcePolicy: "include_local", limit: 1, offset: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.ignores.length, 1);
  addImage(t.db, archived);
  const resolvedTrue = listCleanupIgnores(repo, { localSourcePolicy: "include_local", resolved: "true" });
  assert.deepEqual(resolvedTrue.ignores.map((x) => x.itemId), [archived]);
  const resolvedFalse = listCleanupIgnores(repo, { localSourcePolicy: "include_local", resolved: "false" });
  assert.deepEqual(resolvedFalse.ignores.map((x) => x.itemId).sort((a, b) => a - b), [active, trashed].sort((a, b) => a - b));
  t.close();
});

test("resolved 的 local 正反例；其它规则与策略无关", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const av = addAvatar(t.db, "A");
  const local = addItem(t.db, { title: "local", source_site: "local" }); addImage(t.db, local); linkAvatar(t.db, local, av);
  const archivedLocal = addItem(t.db, { title: "archived-local", source_site: "local", status: "archived" }); addImage(t.db, archivedLocal); linkAvatar(t.db, archivedLocal, av);
  ignore(t.db, local, "missing_source"); ignore(t.db, local, "missing_cover");
  ignore(t.db, archivedLocal, "missing_source");
  const inc = listCleanupIgnores(repo, { localSourcePolicy: "include_local" });
  const exc = listCleanupIgnores(repo, { localSourcePolicy: "exclude_local" });
  const pick = (r: { ignores: { itemId: number; rule: string; resolved: boolean }[] }, id: number, rule: string) =>
    r.ignores.find((x) => x.itemId === id && x.rule === rule);
  assert.equal(pick(inc, local, "missing_source")?.resolved, false);
  assert.equal(pick(exc, local, "missing_source")?.resolved, true);
  assert.equal(pick(inc, local, "missing_cover")?.resolved, true, "有图 → 缺封面已解决");
  assert.equal(pick(exc, local, "missing_cover")?.resolved, true, "其它规则与 local 策略无关");
  assert.equal(pick(inc, archivedLocal, "missing_source")?.resolved, false, "归档不套基础范围");
  assert.equal(pick(exc, archivedLocal, "missing_source")?.resolved, true);
  t.close();
});

test("保存筛选 CRUD：name trim/唯一、CAS expectedVersion、删除幂等", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const f1 = createCleanupFilter(repo, { name: "  f1  ", filter: { localSourcePolicy: "include_local", q: "x" } });
  assert.equal(f1.name, "f1");
  assert.equal(f1.version, 1);
  assert.equal(listCleanupFilters(repo).filters.length, 1);
  assert.throws(() => createCleanupFilter(repo, { name: "F1", filter: { localSourcePolicy: "include_local" } }), isConflict);
  assert.throws(() => createCleanupFilter(repo, { name: "   ", filter: { localSourcePolicy: "include_local" } }), isInvalidInput);
  assert.throws(() => createCleanupFilter(repo, { name: "x".repeat(81), filter: { localSourcePolicy: "include_local" } }), isInvalidInput);
  const f2 = patchCleanupFilter(repo, f1.id, { name: "f2", filter: { localSourcePolicy: "exclude_local", rule: "missing_file" }, expectedVersion: 1 });
  assert.equal(f2.name, "f2");
  assert.equal(f2.version, 2);
  assert.equal(f2.filter.localSourcePolicy, "exclude_local");
  assert.throws(() => patchCleanupFilter(repo, f1.id, { name: "stale", expectedVersion: 1 }), isConflict);
  assert.throws(() => patchCleanupFilter(repo, f1.id, { name: "no-version", expectedVersion: undefined as unknown as number }), isInvalidInput);
  assert.throws(() => patchCleanupFilter(repo, f1.id, { filter: { includeArchived: true, localSourcePolicy: "include_local" } as unknown as CleanupFilter, expectedVersion: 2 }), isInvalidInput);
  assert.throws(() => patchCleanupFilter(repo, 999999, { expectedVersion: 1 }), isNotFound);
  assert.equal(deleteCleanupFilter(repo, f1.id).deleted, 1);
  assert.equal(deleteCleanupFilter(repo, f1.id).deleted, 0);
  assert.equal(listCleanupFilters(repo).filters.length, 0);
  t.close();
});

test("合并忽略：target 同 rule 胜出、source 删除、无关条目不变、审计同事务", () => {
  const t = openTempDb();
  const s = addItem(t.db, { title: "s" }); const tg = addItem(t.db, { title: "t" }); const u = addItem(t.db, { title: "u" });
  ignore(t.db, s, "missing_cover", "s-cover"); ignore(t.db, s, "missing_source", "s-source"); ignore(t.db, s, "missing_file", "s-file");
  ignore(t.db, tg, "missing_cover", "t-cover");
  ignore(t.db, u, "missing_cover", "u-cover");
  const moved = mergeCleanupIgnoresTx(t.db, s, tg);
  assert.equal(moved, 3);
  assert.equal(count(t.db, "cleanup_ignores", "item_id=?", s), 0);
  assert.equal(count(t.db, "cleanup_ignores", "item_id=?", tg), 3);
  const cover = t.db.prepare("SELECT note FROM cleanup_ignores WHERE item_id=? AND rule='missing_cover'").get(tg) as { note: string };
  assert.equal(cover.note, "t-cover", "同 rule 冲突保留 target");
  assert.equal(count(t.db, "cleanup_ignores", "item_id=?", u), 1);
  const audit = t.db.prepare("SELECT * FROM audit_log WHERE action='merge.cleanup_ignores_moved' AND entity_id=?").get(String(tg)) as { before_json: string; after_json: string } | undefined;
  assert.ok(audit, "合并必须同事务写审计");
  assert.match(audit.before_json, /"sourceItemId":/);
  t.close();
});

test("合并忽略：同 id 守卫与审计失败回滚", () => {
  const t = openTempDb();
  const a = addItem(t.db, { title: "a" }); const b = addItem(t.db, { title: "b" });
  ignore(t.db, a, "missing_cover");
  assert.throws(() => mergeCleanupIgnoresTx(t.db, a, a), isInvalidInput);
  assert.equal(count(t.db, "cleanup_ignores", "item_id=?", a), 1, "同 id 不得删除自己的行");
  t.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit fail'); END");
  assert.throws(() => mergeCleanupIgnoresTx(t.db, a, b));
  assert.equal(count(t.db, "cleanup_ignores", "item_id=?", a), 1, "审计失败必须整体回滚");
  assert.equal(count(t.db, "cleanup_ignores", "item_id=?", b), 0);
  t.db.exec("DROP TRIGGER fail_audit");
  t.close();
});

test("忽略 upsert：note 上限、幂等、非法 rule/条目、只写忽略表", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const item = addItem(t.db, { title: "i", source_url: "https://x" });
  const av = addAvatar(t.db, "A"); linkAvatar(t.db, item, av);
  const snap = () => ["items", "assets", "item_images", "item_avatars"].map((tb) => count(t.db, tb)).join(",");
  const before = snap();
  const r1 = upsertCleanupIgnore(repo, { itemId: item, rule: "missing_cover", note: "n".repeat(500) });
  assert.equal(r1.note?.length, 500);
  const r2 = upsertCleanupIgnore(repo, { itemId: item, rule: "missing_cover", note: "updated" });
  assert.equal(r2.note, "updated");
  assert.equal(count(t.db, "cleanup_ignores"), 1, "同 (item,rule) 幂等");
  assert.throws(() => upsertCleanupIgnore(repo, { itemId: item, rule: "missing_cover", note: "n".repeat(501) }), isInvalidInput);
  assert.throws(() => upsertCleanupIgnore(repo, { itemId: item, rule: "bogus" as never }), isInvalidInput);
  assert.throws(() => upsertCleanupIgnore(repo, { itemId: 999999, rule: "missing_cover" }), isNotFound);
  assert.equal(snap(), before, "忽略只写 cleanup_ignores");
  t.close();
});

test("管理列表与筛选列表纯读", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const item = addItem(t.db, { title: "i" }); ignore(t.db, item, "missing_cover");
  createCleanupFilter(repo, { name: "f", filter: { localSourcePolicy: "include_local" } });
  const tables = ["items", "cleanup_ignores", "cleanup_saved_filters", "audit_log"];
  const snap = () => tables.map((tb) => count(t.db, tb)).join(",");
  const before = snap();
  listCleanupIgnores(repo, { localSourcePolicy: "include_local" });
  listCleanupIgnores(repo, { localSourcePolicy: "exclude_local", resolved: "true" });
  listCleanupFilters(repo);
  assert.equal(snap(), before);
  t.close();
});

test("结构去重：只有一个 CASE 分发 builder，且两个真实消费者都调用它", () => {
  const srcPath = fileURLToPath(new URL("../../apps/server/src/db/cleanup.ts", import.meta.url));
  const source = readFileSync(srcPath, "utf8");
  const sf = ts.createSourceFile(srcPath, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const builders: string[] = [];
  const calls: string[] = [];
  const dispatchLiterals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "allRulesHitSql") builders.push(node.name.text);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "allRulesHitSql") calls.push(node.expression.text);
    if (ts.isStringLiteral(node) && node.text.includes("WHEN 'missing_cover' THEN")) dispatchLiterals.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert.equal(builders.length, 1, "只允许一个 allRulesHitSql builder");
  assert.equal(calls.length, 2, "builder 必须被两个真实消费者调用（todos + ignores）");
  assert.equal(dispatchLiterals.length, 1, "CASE 分发只允许在 builder 内出现一次");
  for (const name of ["listCleanupTodos", "listCleanupIgnores"]) {
    const fn = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
    assert.ok(fn, "缺少消费者 " + name);
    assert.ok(fn.getText(sf).includes("allRulesHitSql()"), name + " 必须调用共享 builder");
  }
});
