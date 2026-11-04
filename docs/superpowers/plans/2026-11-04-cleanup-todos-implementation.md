# 整理待办实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 四类派生待办（缺封面/缺来源/未关联模型/文件失联）+ 保存筛选 + 按 `(item, rule)` 忽略/恢复；默认排除归档与回收站；local 策略显式必填。

**Architecture:** 规则与查询集中在 `db/cleanup.ts`（参数化 SQL，不落待办行）；HTTP 在 `http/routes/cleanup.ts` 自注册；UI 为独立 `CleanupPanel`，由总入口挂载。

**Tech Stack:** TypeScript 5.9、Fastify 5、better-sqlite3 13、React 19、`node:test` + tsx。

**Spec:** `docs/superpowers/specs/2026-11-04-cleanup-todos-design.md`（revision-4）。

## Global Constraints

- 基础范围固定 `i.status NOT IN ('archived','trashed')`；保存筛选没有 `includeArchived`/`includeTrashed`，出现即 400。
- 忽略只写 `cleanup_ignores`；不改 `items`/`assets`/`item_images`/`item_avatars`。
- `localSourcePolicy` 三个入口（todos / ignores / filters）都必填；缺失 400 `INVALID_INPUT` + `details.code="LOCAL_POLICY_REQUIRED"`。主 UI 默认选中 `include_local` 并显式传参。
- `missing_source` 空白判定用 `TRIM(x, ' ' || char(9) || char(10) || char(13))`；`source_gone=1` 不折入。
- `unlinked_model` 只看 `item_avatars` 且 `match<>'exclude'`；`asset_avatars` 不算。
- 不新增 `AppErrorCode`；不新增 npm 依赖；GET 纯读。
- 本计划不写 `apps/server/src/http/routes.ts` / `apps/server/src/db/repo.ts`；共享文件由总入口 P1-T2/P1-T3/P1-T5 串行交接。任务期不 `git add`/`commit`，只记录 diff/hash 交接。

## Review Focus

1. `source_url` 只有制表符 → 命中 `missing_source`（Task 1）。
2. `cover_image_id` 指向另一 item 的图 → 不命中 `missing_cover`（Task 1）。
3. 只有 `exclude` 行 → 命中 `unlinked_model`（Task 1）。
4. 缺 `localSourcePolicy` → 400 `LOCAL_POLICY_REQUIRED`（三个入口）（Task 3）。
5. `ignored=only` 的 `total` 与 `counts.total` 口径不同（Task 2）。

---

### Task 1: 四类规则、计数与 local 策略

**Files:**
- Create: `apps/server/src/db/cleanup.ts`
- Test: `test/db/cleanup-rules.test.ts`

**Interfaces:**
- Produces: `type CleanupRule = "missing_cover" | "missing_source" | "unlinked_model" | "missing_file"`；`type LocalSourcePolicy = "exclude_local" | "include_local"`；`parseLocalSourcePolicy(raw: unknown): LocalSourcePolicy`；`listCleanupTodos(repo, q: CleanupQuery): { total: number; counts: CleanupCounts; items: CleanupRow[] }`；`CleanupQuery { rule?; ignored?: "hide"|"show"|"only"; q?; avatarIds?: number[]; categoryIds?: string[]; sort?: "updated"|"title"; localSourcePolicy: LocalSourcePolicy; limit?: number; offset?: number }`。
- Consumes: `repo.connection`、`repo.listItems` 的卡片形状（`ItemCard`）。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openTempDb, addRoot, addItem, addAsset, addAvatar, addImage, count, NOW } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { listCleanupTodos, parseLocalSourcePolicy } from "../../apps/server/src/db/cleanup";

test("四类规则正反例", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const av = addAvatar(t.db, "A");
  const link = (id: number, match = "any") => t.db.prepare("INSERT INTO item_avatars(item_id,avatar_id,match,confidence,source) VALUES (?,?,?,1,'manual')").run(id, av, match);
  const noImg = addItem(t.db, { title: "noimg", source_site: "booth", source_url: "https://x" }); link(noImg);
  const hasImg = addItem(t.db, { title: "hasimg", source_site: "booth", source_url: "https://x" }); addImage(t.db, hasImg); link(hasImg);
  const tab = addItem(t.db, { title: "tab", source_site: "booth", source_url: "\t" }); addImage(t.db, tab); link(tab);
  const gone = addItem(t.db, { title: "gone", source_site: "booth", source_url: "https://x", source_gone: 1 }); addImage(t.db, gone); link(gone);
  const ex = addItem(t.db, { title: "ex", source_site: "booth", source_url: "https://x" }); addImage(t.db, ex); link(ex, "exclude");
  const miss = addItem(t.db, { title: "miss", source_site: "booth", source_url: "https://x" }); addImage(t.db, miss); link(miss);
  addAsset(t.db, miss, rootId, "/lib/m.zip", { status: "missing" });
  const r = listCleanupTodos(repo, { localSourcePolicy: "include_local" });
  const rules = (id: number) => r.items.filter((x) => x.item.id === id).map((x) => x.rule);
  assert.deepEqual(rules(noImg), ["missing_cover"]);
  assert.deepEqual(rules(hasImg), []);
  assert.ok(rules(tab).includes("missing_source"));
  assert.ok(!rules(gone).includes("missing_source"));
  assert.ok(rules(ex).includes("unlinked_model"));
  assert.ok(rules(miss).includes("missing_file"));
  assert.equal(r.counts.missing_cover.total, 1);
  t.close();
});

test("local 策略与缺参 400", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const local = addItem(t.db, { title: "local", source_site: "local" });
  const inc = listCleanupTodos(repo, { localSourcePolicy: "include_local" });
  assert.ok(inc.items.some((x) => x.item.id === local && x.rule === "missing_source"));
  const exc = listCleanupTodos(repo, { localSourcePolicy: "exclude_local" });
  assert.ok(!exc.items.some((x) => x.item.id === local && x.rule === "missing_source"));
  assert.equal(exc.counts.missing_source.localExcluded, 1);
  assert.throws(() => parseLocalSourcePolicy(undefined), (e: any) => e.code === "INVALID_INPUT" && e.details?.code === "LOCAL_POLICY_REQUIRED");
  t.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test test/db/cleanup-rules.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

四条规则按 spec §3 的 SQL 逐字实现（`missing_cover` 用两个 `NOT EXISTS`；`missing_source` 用 charlist TRIM + `source_gone=0` + 策略；`unlinked_model` 用 `match<>'exclude'`；`missing_file` 用 `assets.status='missing'`）。`counts` 不受 `ignored` 影响；`localExcluded` 只在 `exclude_local` 时非零。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import tsx --test test/db/cleanup-rules.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 5: 记录交接（不 commit）**

```bash
mkdir -p /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup
cp --parents apps/server/src/db/cleanup.ts test/db/cleanup-rules.test.ts /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup/
sha256sum apps/server/src/db/cleanup.ts test/db/cleanup-rules.test.ts | tee /root/Code/.asset-vault-feature123-20261104/planning/handoff/P4-T1.sha256
git diff --cached --stat   # 必须为空
```
Expected: 备份/hash 落盘；索引/HEAD 未变。

---

### Task 2: 忽略/resolved 与保存筛选

**Files:**
- Modify: `apps/server/src/db/cleanup.ts`
- Test: `test/db/cleanup-ignores.test.ts`

**Interfaces:**
- Produces: `listCleanupIgnores(repo, q: { resolved?: "any"|"true"|"false"; localSourcePolicy: LocalSourcePolicy; limit?: number; offset?: number }): { total: number; ignores: CleanupIgnoreRow[] }`；`upsertCleanupIgnore(repo, input: { itemId: number; rule: CleanupRule; note?: string | null }): CleanupIgnoreRow`；`deleteCleanupIgnore(repo, itemId, rule): { removed: 0 | 1 }`；`listCleanupFilters(repo)`；`createCleanupFilter(repo, input)`；`patchCleanupFilter(repo, id, input)`；`deleteCleanupFilter(repo, id)`；`validateCleanupFilter(raw: unknown): CleanupFilter`；`mergeCleanupIgnoresTx(db, sourceItemId, targetItemId): number`。
- Consumes: Task 1 的规则求值。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openTempDb, addItem, addImage, addAvatar, count } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { listCleanupTodos, listCleanupIgnores, upsertCleanupIgnore, deleteCleanupIgnore, validateCleanupFilter, createCleanupFilter } from "../../apps/server/src/db/cleanup";

test("忽略粘性、resolved 随策略变化、ignored=only 口径", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const local = addItem(t.db, { title: "local", source_site: "local" }); addImage(t.db, local);
  const av = addAvatar(t.db, "A");
  t.db.prepare("INSERT INTO item_avatars(item_id,avatar_id,match,confidence,source) VALUES (?,?,'any',1,'manual')").run(local, av);
  assert.equal(listCleanupTodos(repo, { q: "' OR 1=1 --", localSourcePolicy: "include_local" }).total, 0);
  const before = t.db.prepare("SELECT * FROM items WHERE id=?").get(local);
  upsertCleanupIgnore(repo, { itemId: local, rule: "missing_source" });
  assert.deepEqual(t.db.prepare("SELECT * FROM items WHERE id=?").get(local), before);
  assert.equal(listCleanupTodos(repo, { localSourcePolicy: "include_local" }).items.length, 0);
  const only = listCleanupTodos(repo, { localSourcePolicy: "include_local", ignored: "only" });
  assert.equal(only.total, 1); assert.equal(only.items[0].resolved, false);
  assert.equal(only.counts.missing_source.total, 1);
  const exc = listCleanupIgnores(repo, { localSourcePolicy: "exclude_local" });
  assert.equal(exc.ignores[0].resolved, true);
  assert.equal(deleteCleanupIgnore(repo, local, "missing_source").removed, 1);
  assert.equal(deleteCleanupIgnore(repo, local, "missing_source").removed, 0);
  t.close();
});

test("保存筛选严格校验：未知键/缺策略 400", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  assert.throws(() => validateCleanupFilter({ includeArchived: true, localSourcePolicy: "include_local" }), (e: any) => e.code === "INVALID_INPUT");
  assert.throws(() => validateCleanupFilter({ rule: "missing_cover" }), (e: any) => e.details?.code === "LOCAL_POLICY_REQUIRED");
  const f = createCleanupFilter(repo, { name: "f1", filter: validateCleanupFilter({ localSourcePolicy: "include_local", q: "' OR 1=1 --" }) });
  assert.equal(f.version, 1);
  assert.equal(count(t.db, "cleanup_saved_filters"), 1);
  t.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test test/db/cleanup-ignores.test.ts`
Expected: FAIL —— 函数不存在。

- [ ] **Step 3: 实现**

`resolved` 按 `(item, rule)` 单独求值（不套基础范围）；`missing_source` 的 local 分支按请求策略。`ignored=only` 以忽略表为驱动 left join 规则。保存筛选：未知键拒绝、`localSourcePolicy` 必填、`q` 参数化。合并：`INSERT OR IGNORE` 后删 source。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import tsx --test test/db/cleanup-ignores.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 5: 记录交接（不 commit）**

```bash
mkdir -p /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup
cp --parents apps/server/src/db/cleanup.ts test/db/cleanup-ignores.test.ts /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup/
sha256sum apps/server/src/db/cleanup.ts test/db/cleanup-ignores.test.ts | tee /root/Code/.asset-vault-feature123-20261104/planning/handoff/P4-T2.sha256
git diff --cached --stat   # 必须为空
```
Expected: 备份/hash 落盘；索引/HEAD 未变。

---

### Task 3: 待办 HTTP 端点（三个入口都必填策略）

**Files:**
- Create: `apps/server/src/http/routes/cleanup.ts`
- Test: `test/http/cleanup-routes.test.ts`

**Interfaces:**
- Produces: `registerCleanupRoutes(app, deps): void`，注册 `GET /api/cleanup/todos`、`GET /api/cleanup/ignores`、`POST /api/cleanup/ignore`、`DELETE /api/cleanup/ignore/:itemId/:rule`、`GET/POST/PATCH/DELETE /api/cleanup/filters`。
- Consumes: Task 1/2 全部函数。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { openTempDb, addItem } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerCleanupRoutes } from "../../apps/server/src/http/routes/cleanup";

test("todos/ignores/filters 缺策略一律 400", async () => {
  const t = openTempDb(); const repo = new Repo(t.db); addItem(t.db, { title: "x" });
  const app = Fastify({ logger: false }); registerCleanupRoutes(app as any, { repo, log: () => {} } as any);
  for (const url of ["/api/cleanup/todos", "/api/cleanup/ignores"]) {
    const r = await app.inject({ method: "GET", url });
    assert.equal(r.statusCode, 400); assert.equal(JSON.parse(r.body).error.details.code, "LOCAL_POLICY_REQUIRED");
  }
  const f = await app.inject({ method: "POST", url: "/api/cleanup/filters", payload: { name: "f", filter: { rule: "missing_cover" } } });
  assert.equal(f.statusCode, 400); assert.equal(JSON.parse(f.body).error.details.code, "LOCAL_POLICY_REQUIRED");
  const ok = await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=include_local" });
  assert.equal(ok.statusCode, 200); assert.ok(Array.isArray(JSON.parse(ok.body).items));
  t.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test test/http/cleanup-routes.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

每个入口先 `parseLocalSourcePolicy`，再解析其余参数；`limit` 默认 50/上限 200；错误统一 `INVALID_INPUT`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import tsx --test test/http/cleanup-routes.test.ts`
Expected: PASS。

- [ ] **Step 5: 记录交接（不 commit）**

```bash
mkdir -p /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup
cp --parents apps/server/src/http/routes/cleanup.ts test/http/cleanup-routes.test.ts /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup/
sha256sum apps/server/src/http/routes/cleanup.ts test/http/cleanup-routes.test.ts | tee /root/Code/.asset-vault-feature123-20261104/planning/handoff/P4-T3.sha256
git diff --cached --stat   # 必须为空
```
Expected: 备份/hash 落盘；索引/HEAD 未变。

---

### Task 4: 整理待办面板

**Files:**
- Create: `apps/web/src/components/CleanupPanel.tsx`
- Create: `apps/web/src/cleanup-view.ts`（`ruleLabel`、`resolvedLabel`、`countsCaption`）
- Test: `test/web/cleanup-view.test.ts`

**Interfaces:**
- Produces: `ruleLabel(r: CleanupRule): string`；`resolvedLabel(resolved: boolean | null): string`；`countsCaption(c: CleanupCounts): string`。
- Consumes: Task 3 的端点与总入口的 `CleanupTodosResponse` 类型。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ruleLabel, resolvedLabel, countsCaption } from "../../apps/web/src/cleanup-view";

test("规则文案与 resolved 文案固定", () => {
  assert.equal(ruleLabel("missing_cover"), "缺封面");
  assert.equal(ruleLabel("missing_file"), "文件失联");
  assert.equal(resolvedLabel(true), "问题当前不存在");
  assert.equal(resolvedLabel(false), "问题当前存在");
  assert.match(countsCaption({ missing_cover: { total: 1, ignored: 0 }, missing_source: { total: 2, ignored: 1, localExcluded: 3 }, unlinked_model: { total: 0, ignored: 0 }, missing_file: { total: 0, ignored: 0 } }), /被排除 3 条/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test test/web/cleanup-view.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

面板：四个 rule tab + 计数、搜索、头像/分类筛选、显示已忽略开关、保存筛选下拉、local 策略**必选**（默认选中 `include_local`，无“未选”提交态）、被排除数展示；“已忽略管理”独立入口同样必选策略。`missing_file` 行显示“库内标记为缺失（来自上次扫描/确认），不是实时磁盘检查”。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import tsx --test test/web/cleanup-view.test.ts`
Expected: PASS。

- [ ] **Step 5: 记录交接（不 commit）**

```bash
mkdir -p /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup
cp --parents apps/web/src/components/CleanupPanel.tsx apps/web/src/cleanup-view.ts test/web/cleanup-view.test.ts /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup/
sha256sum apps/web/src/components/CleanupPanel.tsx apps/web/src/cleanup-view.ts test/web/cleanup-view.test.ts | tee /root/Code/.asset-vault-feature123-20261104/planning/handoff/P4-T4.sha256
git diff --cached --stat   # 必须为空
```
Expected: 备份/hash 落盘；索引/HEAD 未变。
