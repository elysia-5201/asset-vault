# Feature 1-2-3 共享前置、集成与 Git 交付实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 schema v10、错误子码、资产归属共享事务与前端公共类型，把三个子功能接进真实路由/UI，并以显式路径提交推送。

**Architecture:** 共享文件按“前置阶段 → 集成阶段”串行交接：`schema.sql`/`migrate.ts` 由 P1-T1 独占，`contracts.ts` 由 P1-T2 独占，`repo.ts` 由 P1-T3（共享事务）→ P1-T5（merge 钩子）两阶段串行，`routes.ts` 由 P1-T2（错误 details）→ P1-T5（接线）两阶段串行；任何时刻只有一个写者，后一阶段先核前一阶段 hash 再动文件。三个子功能各自新增独立模块与独立 `registerXxxRoutes`，集成任务只做接线，不重写业务。

**Tech Stack:** TypeScript 5.9、Fastify 5、better-sqlite3 13、React 19、`node:test` + tsx。

**Spec:** `docs/superpowers/specs/2026-11-04-feature123-design.md`（总览）+ 三份子设计（同目录）。

## Global Constraints

- `SCHEMA_VERSION` 9→10 只 bump 一次；新表/索引/触发器全部 additive；不改既有表、列、索引。
- 不新增 npm 依赖；不新增 `JobKind`/`JobState`/`AppErrorCode`；子码只放 `details.code`。
- 既有 API 响应形状不变；新端点与新可选字段 additive。
- 不做 AI/云/自动 Unity/后台扫描引擎；不自动合并/跳过/改归属；不删/移源文件。
- 测试：单文件 `node --import tsx --test <file>`；全量 `node scripts/test.mjs`；类型 `npx tsc --noEmit`；前端构建 `npm run build:web`。
- 所有测试/服务只连临时 fixture DB 与临时目录；不碰 7317 运行版、`data/`、`logs/`、真实素材与缓存。`main.ts` 只读 `PORT`/`HOST`/`ASSETVAULT_DATA`，`logsDir` 硬编码为 `<repo>/logs`（`server.ts:66`），因此隔离服务必须用 fixture launcher 显式传 `logsDir`，不能直接跑 `main.ts`。
- 任务执行期不 `git add`/`git commit`/`git push`；每步只记录 diff/备份/hash 并交接，最终由 Task 6 在独立验收后统一 staging/commit/push。
- 提交只列显式路径；禁止 `git add -A`。
- 既有 `skip` 保持 `skip`；报告逐条注明，不把 skip 计为通过。

## Review Focus

1. v9 库已有数据再迁移 → 行数不变、`schema_meta.version=10`、二次迁移 no-op（Task 1）。
2. 跨 item 插版本关系 → 触发器 ABORT、不落行（Task 1）。
3. 带版本关系的 asset 走非 merge 路径改 owner → 409 `ASSET_HAS_VERSION_LINKS`、owner 不变（Task 3）。
4. 合并事务中途断言失败 → 资产与关系全回滚（Task 3）。
5. 错误响应 `details.code` → 外层 `code` 不变、无 details 时不出现该键（Task 2）。

## 共享文件写者与串行交接

| 文件 | 阶段 1（前置） | 阶段 2（集成） | 规则 |
|---|---|---|---|
| `apps/server/src/http/routes.ts` | P1-T2：`fail` 导出 + `details` 序列化（Task 2） | P1-T5：注册三路由 + `/api/import/*` 委托 + expected 门（Task 5） | 串行；P1-T5 必须等 P1-T2 完成并核对 hash；任何时刻唯一写者 |
| `apps/server/src/db/repo.ts` | P1-T3：`connection` + 共享归属事务（Task 3） | P1-T5：`mergeItems` 调 `mergeLoadoutItemsTx`/`mergeCleanupIgnoresTx`（Task 5） | 串行；不得并行重叠；P1-T5 先核 P1-T3 hash |

- 三个子计划只新增 `http/routes/{import-precheck,loadouts,cleanup}.ts` 等独立模块，**不写** `routes.ts`/`repo.ts`。
- 每次交接落 `planning/handoff/<task>.sha256`（改动文件 hash）与 `planning/handoff/<task>.patch`（仅对已跟踪文件用 `git diff`；新文件及未跟踪文件一律 `cp --parents` 全量备份到 `planning/handoff/backup/`）；下一写者先 `sha256sum -c` 再编辑，失败即停。
- 交接记录不触碰索引/HEAD：`git diff --cached --stat` 必须为空，`git rev-parse HEAD` 不变。

---

### Task 1: schema v10（单一迁移 owner）

**Files:**
- Modify: `apps/server/src/db/schema.sql`（文件末尾追加三节 DDL）
- Modify: `apps/server/src/db/migrate.ts:6-11`（版本注释 + `SCHEMA_VERSION = 10`）
- Test: `test/schema/v10.test.ts`

**Interfaces:**
- Produces: 表 `asset_version_links`、`import_stage_commits`、`loadouts`、`loadout_items`、`cleanup_ignores`、`cleanup_saved_filters`；索引 `ix_avlink_item`、`ix_avlink_a`、`ix_avlink_b`、`ix_stage_commits_created`、`ix_loadouts_avatar`、`ix_loadout_items_item`、`ix_loadout_items_state`、`ix_loadout_items_live`、`ix_cleanup_ignores_rule`；触发器 `trg_avlink_same_item_ins`、`trg_avlink_same_item_upd`；`SCHEMA_VERSION = 10`。
- Consumes: 无（本任务是最底层）。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openTempDb, expectConstraint, addRoot, addItem, addAsset, count, NOW } from "./_db";
import { migrate, SCHEMA_VERSION } from "../../apps/server/src/db/migrate";

const NEW_TABLES = ["loadout_items","loadouts","cleanup_ignores","cleanup_saved_filters","asset_version_links","import_stage_commits"];

test("v9 → v10 幂等迁移，既有行数不变", () => {
  const t = openTempDb();
  const rootId = addRoot(t.db, "/lib");
  const itemId = addItem(t.db, { title: "keep" });
  addAsset(t.db, itemId, rootId, "/lib/a.zip");
  for (const tbl of NEW_TABLES) t.db.exec("DROP TABLE " + tbl);
  t.db.prepare("INSERT INTO schema_meta(key,value) VALUES('version','9') ON CONFLICT(key) DO UPDATE SET value='9'").run();
  const before = { items: count(t.db, "items"), assets: count(t.db, "assets") };
  migrate(t.db);
  assert.equal(SCHEMA_VERSION, 10);
  assert.equal((t.db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as any).value, "10");
  for (const tbl of NEW_TABLES) assert.equal(count(t.db, "sqlite_master", "type='table' AND name=?", tbl), 1, tbl);
  assert.deepEqual({ items: count(t.db, "items"), assets: count(t.db, "assets") }, before);
  migrate(t.db);
  assert.deepEqual({ items: count(t.db, "items"), assets: count(t.db, "assets") }, before);
  t.close();
});

test("跨 item 版本关系被触发器拒绝", () => {
  const t = openTempDb();
  const rootId = addRoot(t.db, "/lib");
  const a = addItem(t.db, { title: "A" }); const b = addItem(t.db, { title: "B" });
  const a1 = addAsset(t.db, a, rootId, "/lib/a1.zip"); const b1 = addAsset(t.db, b, rootId, "/lib/b1.zip");
  const e = expectConstraint(() => t.db.prepare("INSERT INTO asset_version_links(item_id,asset_a_id,asset_b_id,relation,basis,state,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(a, a1, b1, "same", "manual", "candidate", 1, NOW, NOW));
  assert.match(e.message, /both assets must belong to item_id/);
  assert.equal(count(t.db, "asset_version_links"), 0);
  t.close();
});

test("CHECK / UNIQUE / CASCADE 成对成立", () => {
  const t = openTempDb();
  const rootId = addRoot(t.db, "/lib"); const a = addItem(t.db, { title: "A" });
  const a1 = addAsset(t.db, a, rootId, "/lib/1.zip"); const a2 = addAsset(t.db, a, rootId, "/lib/2.zip");
  const ins = (rel: string, x: number, y: number) => t.db.prepare("INSERT INTO asset_version_links(item_id,asset_a_id,asset_b_id,relation,basis,state,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(a, x, y, rel, "manual", "candidate", 1, NOW, NOW);
  expectConstraint(() => ins("bogus", a1, a2), "CHECK");
  expectConstraint(() => ins("same", a2, a1), "CHECK");
  ins("same", a1, a2);
  expectConstraint(() => ins("same", a1, a2), "UNIQUE");
  t.db.prepare("DELETE FROM assets WHERE id=?").run(a2);
  assert.equal(count(t.db, "asset_version_links"), 0);
  t.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test test/schema/v10.test.ts`
Expected: FAIL —— `no such table: asset_version_links` / `SCHEMA_VERSION` 仍为 9。

- [ ] **Step 3: 追加 DDL 并 bump 版本**

按 spec 逐字追加，不改字段名/约束：import §5.1（`asset_version_links` + 3 索引）、§5.2（2 触发器）、§5.4（`import_stage_commits` + 1 索引）；loadouts §5.1（`loadouts` + 1 索引）、§5.2（`loadout_items` + 3 索引）；cleanup §5.1（`cleanup_ignores` + 1 索引）、§5.2（`cleanup_saved_filters`）。`migrate.ts` 只改版本常量与注释，不加 `COLUMN_MIGRATIONS` 条目。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import tsx --test test/schema/v10.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 5: 回归 + 记录交接（不 commit）**

Run: `node --import tsx --test test/schema/constraints.test.ts test/schema/v5.test.ts`
Expected: PASS（既有约束未被新表影响）。

```bash
mkdir -p /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup
git diff -- apps/server/src/db/schema.sql apps/server/src/db/migrate.ts > /root/Code/.asset-vault-feature123-20261104/planning/handoff/P1-T1.patch
cp --parents test/schema/v10.test.ts /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup/
sha256sum apps/server/src/db/schema.sql apps/server/src/db/migrate.ts test/schema/v10.test.ts | tee /root/Code/.asset-vault-feature123-20261104/planning/handoff/P1-T1.sha256
git diff --cached --stat   # 必须为空
git rev-parse HEAD         # 必须仍为 cbabb82333124fd742d6caa53839d3bfa58c0afa
```
Expected: diff/备份/hash 落盘；索引与 HEAD 未变。不 `git add`、不 `git commit`。

---

### Task 2: 错误子码 `details`（additive）

**Files:**
- Modify: `packages/core/src/contracts.ts:219-225`
- Modify: `apps/server/src/http/routes.ts:78-85`（`fail` 导出并序列化 details）
- Test: `test/http/error-details.test.ts`

**Interfaces:**
- Produces: `interface AppErrorDetails { code?: string; [k: string]: unknown }`；`new AppError(code, message, status?, details?)`；`fail(reply, e)` 输出 `{error:{code,message,details?}}`。
- Handoff: `routes.ts` 前置阶段 hash 落 `planning/handoff/P1-T2.sha256`；P1-T5 先核再写。
- Consumes: 无。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fail } from "../../apps/server/src/http/routes";
import { AppError } from "../../packages/core/src/contracts";

test("details.code 序列化；无 details 时不出现该键", () => {
  const sent: any = {};
  const reply = { status(c: number) { sent.status = c; return this; }, send(b: any) { sent.body = b; return this; } } as any;
  fail(reply, new AppError("CONFLICT", "x", 409, { code: "PATH_OWNED_BY_OTHER_ITEM" }));
  assert.equal(sent.status, 409);
  assert.deepEqual(sent.body, { error: { code: "CONFLICT", message: "x", details: { code: "PATH_OWNED_BY_OTHER_ITEM" } } });
  fail(reply, new AppError("INVALID_INPUT", "y", 400));
  assert.equal("details" in sent.body.error, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test test/http/error-details.test.ts`
Expected: FAIL —— `fail` 未导出 / 构造器不接受第 4 参。

- [ ] **Step 3: 实现**

`contracts.ts` 只加可选 `details` 与 `AppErrorDetails`，**不动** `AppErrorCode` 联合；`fail` 仅在 `err.details` 为对象时附带 `details`。

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `node --import tsx --test test/http/error-details.test.ts && npx tsc --noEmit`
Expected: PASS；类型检查 0 error（外层枚举未变）。

- [ ] **Step 5: 记录交接（不 commit）**

```bash
mkdir -p /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup
git diff -- packages/core/src/contracts.ts apps/server/src/http/routes.ts > /root/Code/.asset-vault-feature123-20261104/planning/handoff/P1-T2.patch
cp --parents test/http/error-details.test.ts /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup/
sha256sum packages/core/src/contracts.ts apps/server/src/http/routes.ts test/http/error-details.test.ts | tee /root/Code/.asset-vault-feature123-20261104/planning/handoff/P1-T2.sha256
git diff --cached --stat   # 必须为空
```
Expected: `routes.ts` 前置阶段 hash 落盘，供 P1-T5 核对；索引/HEAD 未变。

---

### Task 3: 资产归属共享事务与版本关系迁移

**Files:**
- Modify: `apps/server/src/db/repo.ts`（constructor 后加 `connection`；`upsertAsset` 402-431；`moveAssets` 657-660；`mergeItems` 576-654）
- Test: `test/db/version-links-owner.test.ts`

**Interfaces:**
- Produces: `get connection(): Database.Database`；`assertAssetOwnerChange(assetId: number, newItemId: number, ctx?: { merge?: boolean }): void`；`moveAssetsAndVersionLinksTx(fromItemId: number, toItemId: number, ctx?: { merge?: boolean }): { assets: number; links: number }`。
- Handoff: `repo.ts` 前置阶段 hash 落 `planning/handoff/P1-T3.sha256`；P1-T5 先核再写。
- Consumes: Task 1 的 `asset_version_links`。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openTempDb, addRoot, addItem, addAsset, count, NOW } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";

test("非 merge 改 owner 被拒；merge 迁移关系并保留 id/state/version", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  assert.equal(repo.connection, t.db);
  const rootId = addRoot(t.db, "/lib");
  const A = addItem(t.db, { title: "A" }); const B = addItem(t.db, { title: "B" });
  const a1 = addAsset(t.db, A, rootId, "/lib/a1.zip"); const a2 = addAsset(t.db, A, rootId, "/lib/a2.zip");
  t.db.prepare("INSERT INTO asset_version_links(item_id,asset_a_id,asset_b_id,relation,basis,state,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(A, a1, a2, "same", "manual", "confirmed", 3, NOW, NOW);
  const before = t.db.prepare("SELECT * FROM asset_version_links").get() as any;
  assert.throws(() => repo.upsertAsset({ item_id: B, kind: "archive", container: "zip", path: "/lib/a1.zip", path_norm: "/lib/a1.zip", root_id: rootId, size: 1, mtime: NOW, discovered_by: "manual" }), (e: any) => e.code === "CONFLICT" && e.details?.code === "ASSET_HAS_VERSION_LINKS");
  assert.equal((t.db.prepare("SELECT item_id FROM assets WHERE id=?").get(a1) as any).item_id, A);
  repo.mergeItems(A, B);
  const after = t.db.prepare("SELECT * FROM asset_version_links").get() as any;
  assert.equal(after.item_id, B); assert.equal(after.id, before.id);
  assert.equal(after.state, "confirmed"); assert.equal(after.version, 3);
  assert.equal(count(t.db, "asset_version_links"), 1);
  t.close();
});

test("事务末断言失败 → 资产与关系全回滚", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const rootId = addRoot(t.db, "/lib");
  const A = addItem(t.db, { title: "A" }); const B = addItem(t.db, { title: "B" });
  const a1 = addAsset(t.db, A, rootId, "/lib/a1.zip"); const a2 = addAsset(t.db, A, rootId, "/lib/a2.zip");
  t.db.prepare("INSERT INTO asset_version_links(item_id,asset_a_id,asset_b_id,relation,basis,state,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(A, a1, a2, "same", "manual", "candidate", 1, NOW, NOW);
  const orig = repo.moveAssetsAndVersionLinksTx.bind(repo);
  (repo as any).moveAssetsAndVersionLinksTx = () => { t.db.prepare("UPDATE assets SET item_id=? WHERE item_id=?").run(B, A); return { assets: 2, links: 0 }; };
  assert.throws(() => repo.mergeItems(A, B), /归属不一致/);
  assert.equal((t.db.prepare("SELECT item_id FROM assets WHERE id=?").get(a1) as any).item_id, A);
  assert.equal((t.db.prepare("SELECT item_id FROM asset_version_links").get() as any).item_id, A);
  (repo as any).moveAssetsAndVersionLinksTx = orig;
  t.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test test/db/version-links-owner.test.ts`
Expected: FAIL —— `repo.connection` undefined / `moveAssetsAndVersionLinksTx` 不存在。

- [ ] **Step 3: 实现**

`assertAssetOwnerChange`：同 owner 通过；有 `asset_version_links` 行且 `ctx.merge !== true` → `new AppError("CONFLICT", "资产有版本关系，不能直接改归属", 409, { code: "ASSET_HAS_VERSION_LINKS" })`。`moveAssetsAndVersionLinksTx`：逐 asset 断言 → `UPDATE assets SET item_id=?` → `UPDATE asset_version_links SET item_id=?, updated_at=?` → 断言 `l.item_id<>a.item_id OR l.item_id<>b.item_id` 计数为 0，否则抛 `CONFLICT`。`upsertAsset` 已存在分支在 UPDATE 前调用断言（`merge:false`）；`moveAssets` 与 `mergeItems` 改调共享事务（`merge:true`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import tsx --test test/db/version-links-owner.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 5: 回归 + 记录交接（不 commit）**

Run: `node --import tsx --test test/db/merge-images.test.ts test/schema/constraints.test.ts`
Expected: PASS（合并既有语义未变）。

```bash
mkdir -p /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup
git diff -- apps/server/src/db/repo.ts > /root/Code/.asset-vault-feature123-20261104/planning/handoff/P1-T3.patch
cp --parents test/db/version-links-owner.test.ts /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup/
sha256sum apps/server/src/db/repo.ts test/db/version-links-owner.test.ts | tee /root/Code/.asset-vault-feature123-20261104/planning/handoff/P1-T3.sha256
git diff --cached --stat   # 必须为空
```
Expected: `repo.ts` 前置阶段 hash 落盘，供 P1-T5 核对；索引/HEAD 未变。

---

### Task 4: 前端公共类型与 API 错误细节

**Files:**
- Modify: `apps/web/src/api.ts`（`ApiError` 加 `details`；`describeError` 追加子码）
- Modify: `apps/web/src/types.ts`（新增全部响应类型）
- Test: `test/web/api-error-details.test.ts`

**Interfaces:**
- Produces: `ApiError.details?: { code?: string }`；`describeError(e)` 在 details.code 存在时返回 `"<message>（<code>）"`；类型 `PrecheckResponse`、`PrecheckResult`、`VersionLink`、`LoadoutState`、`Loadout`、`LoadoutItem`、`LoadoutDetail`、`CleanupRule`、`CleanupTodoRow`、`CleanupTodosResponse`、`CleanupIgnore`、`CleanupIgnoresResponse`、`CleanupFilter`、`CleanupFilterRow`、`LocalSourcePolicy`。服务端行类型由各 `db/*.ts` 自己定义，统一 `*Row` 后缀，不复用 web 名。
- Consumes: Task 2 的 `details` 响应形状。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, describeError } from "../../apps/web/src/api";

test("ApiError 保留 details.code，describeError 带子码", () => {
  const e = new ApiError("CONFLICT", "路径已被占用", 409, { code: "PATH_OWNED_BY_OTHER_ITEM" });
  assert.equal(e.details?.code, "PATH_OWNED_BY_OTHER_ITEM");
  assert.equal(describeError(e), "路径已被占用（PATH_OWNED_BY_OTHER_ITEM）");
  assert.equal(describeError(new ApiError("INVALID_INPUT", "x", 400)), "x");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test test/web/api-error-details.test.ts`
Expected: FAIL —— 构造器只接受 3 参。

- [ ] **Step 3: 实现**

`request()` 的错误分支把 `e.details` 原样传给 `ApiError`；类型按三份子计划 Interfaces 的字段名与可空性逐字定义，不新增 `any`。

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `node --import tsx --test test/web/api-error-details.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: 记录交接（不 commit）**

```bash
mkdir -p /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup
git diff -- apps/web/src/api.ts apps/web/src/types.ts > /root/Code/.asset-vault-feature123-20261104/planning/handoff/P1-T4.patch
cp --parents test/web/api-error-details.test.ts /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup/
sha256sum apps/web/src/api.ts apps/web/src/types.ts test/web/api-error-details.test.ts | tee /root/Code/.asset-vault-feature123-20261104/planning/handoff/P1-T4.sha256
git diff --cached --stat   # 必须为空
```
Expected: diff/备份/hash 落盘；索引/HEAD 未变。

---

### Task 5: 集成接线 + 端到端验证

**Files:**
- Modify: `apps/server/src/http/routes.ts`（注册三个路由模块；`/api/import/paths` 委托；`/api/import/download` 加 `stage` 分支；`/api/items/:id/assets` 加 expected/pathCollision）
- Modify: `apps/server/src/db/repo.ts`（`mergeItems` 调 `mergeLoadoutItemsTx` + `mergeCleanupIgnoresTx`）
- Modify: `apps/web/src/components/ItemDetail.tsx`（挂 `<VersionLinksSection>` 与 `<AddToLoadoutButton>`）
- Modify: `apps/web/src/App.tsx`（“整理待办”菜单项 + 两个面板 + 传 `onOpenLoadouts`）
- Modify: `apps/web/src/components/AvatarRail.tsx`（pane-head 加“搭配”按钮）
- Modify: `docs/api.md`（**只追加**新端点章节，不改既有条目）
- Create: `test/e2e/feature123-fixture-server.ts`（隔离 fixture launcher：显式 `port`/`host`/`dataDir`/`logsDir`，启动前硬校验）
- Test: `test/http/feature123-wiring.test.ts`

**Interfaces:**
- Consumes: P1-T2 交接的 `routes.ts` hash、P1-T3 交接的 `repo.ts` hash（先 `sha256sum -c` 再编辑）；`registerImportPrecheckRoutes`、`registerLoadoutRoutes`、`registerCleanupRoutes`（均 `(app, deps) => void`）；`createImportPathJobs`、`stageDownload`、`verifyExpectedOrThrow`、`mergeLoadoutItemsTx`、`mergeCleanupIgnoresTx`。
- Produces: 真实 `/api/*` 路径可达。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { openTempDb, addItem, addAvatar } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerRoutes } from "../../apps/server/src/http/routes";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";

test("三条新路由经 registerRoutes 可达", async () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const av = addAvatar(t.db, "A"); const it = addItem(t.db, { title: "i" });
  const app = Fastify({ logger: false });
  registerRoutes(app as any, { repo, media: {} as any, booth: {} as any, runner: {} as any, log: () => {}, version: "t", dbPath: "/tmp/t.db", dataDir: "/tmp", pipeline: null, limits: resolveLimits({}) } as any);
  assert.equal((await app.inject({ method: "POST", url: "/api/import/precheck", payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/api/avatars/" + av + "/loadouts" })).statusCode, 200);
  const cl = await app.inject({ method: "GET", url: "/api/cleanup/todos" });
  assert.equal(cl.statusCode, 400);
  assert.equal(JSON.parse(cl.body).error.details.code, "LOCAL_POLICY_REQUIRED");
  assert.equal((await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=include_local" })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/import/download/commit", payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/api/items/" + it + "/version-links" })).statusCode, 200);
  t.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test test/http/feature123-wiring.test.ts`
Expected: FAIL —— 新路径 404。

- [ ] **Step 3: 接线**

只加调用，不改业务：`registerRoutes` 末尾调用三个 `registerXxxRoutes(app, deps)`；`/api/import/paths` 改为 `return createImportPathJobs({ repo }, (req.body ?? {}) as any)`；`/api/import/download` 在参数解析后 `if (b.stage === true) return stageDownload({ repo, media, booth, log: deps.log, dataDir: deps.dataDir }, b)`；`/api/items/:id/assets` 在 `statSync` 前 `await verifyExpectedOrThrow({ repo }, itemId, p, (req.body as any)?.expected)`。

- [ ] **Step 4: 跑测试 + 全量验证**

Run: `node --import tsx --test test/http/feature123-wiring.test.ts && npx tsc --noEmit && node scripts/test.mjs && npm run build:web`
Expected: 全部 PASS；构建产出 `apps/web/dist/`（不入库）。

- [ ] **Step 5: 隔离端到端（fixture launcher，不碰 7317/真实 data/logs）**

先建唯一临时目录与合成 fixture（launcher 内完成，不手写固定路径）：

```bash
FIXTURE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/av-e2e.XXXXXX")
node --import tsx test/e2e/feature123-fixture-server.ts "$FIXTURE_DIR" 7391
```

`test/e2e/feature123-fixture-server.ts` 必须：
1. 只接受绝对 `FIXTURE_DIR` 与 `PORT` 两个 argv；缺参、`FIXTURE_DIR` 不在 `os.tmpdir()` 下、等于/位于 `<repo>/data` 或 `<repo>/logs`、`PORT===7317` → `process.exit(2)`，**不调用 `startAssetVault`**。
2. 在 `FIXTURE_DIR` 内建 `vault.db`（`openDatabase`）、`media/`（一张 1×1 PNG）、`logs/`；插入一个 avatar、一个 item、一个 asset 的最小合成行。
3. `startAssetVault({ port, host: "127.0.0.1", dataDir: FIXTURE_DIR, logsDir: join(FIXTURE_DIR,"logs"), version: "fixture" })`；启动后断言 `handle.dataDir===FIXTURE_DIR`、`handle.port===PORT`、`handle.url==="http://127.0.0.1:"+PORT`，并用 `handle.repo.connection.prepare("PRAGMA database_list").all()` 断言 db 文件路径 === `join(FIXTURE_DIR,"vault.db")`；任一不符 → `handle.close()` 后 `process.exit(3)`。
4. 打印 `FIXTURE_OK dataDir=... dbPath=... port=...` 后才允许浏览器接入。

用 Chrome 只打开 launcher 打印的 URL：预检卡、搭配面板、整理待办面板各出现一次；控制台无 error；所有业务 POST 只发往该 URL。完成后 `SIGTERM` 关闭，`rm -rf "$FIXTURE_DIR"` 前先 `case "$FIXTURE_DIR" in "${TMPDIR:-/tmp}"/av-e2e.*) ...` 核实绝对路径，并保留 launcher 日志。

- [ ] **Step 6: 记录交接（不 commit）**

```bash
mkdir -p /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup
git diff -- apps/server/src/http/routes.ts apps/server/src/db/repo.ts apps/web/src/components/ItemDetail.tsx apps/web/src/App.tsx apps/web/src/components/AvatarRail.tsx docs/api.md > /root/Code/.asset-vault-feature123-20261104/planning/handoff/P1-T5.patch
cp --parents test/http/feature123-wiring.test.ts test/e2e/feature123-fixture-server.ts /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup/
sha256sum apps/server/src/http/routes.ts apps/server/src/db/repo.ts apps/web/src/components/ItemDetail.tsx apps/web/src/App.tsx apps/web/src/components/AvatarRail.tsx docs/api.md test/http/feature123-wiring.test.ts test/e2e/feature123-fixture-server.ts | tee /root/Code/.asset-vault-feature123-20261104/planning/handoff/P1-T5.sha256
git diff --cached --stat   # 必须为空
```
Expected: 集成阶段 hash 落盘；索引/HEAD 未变。最终提交留给 Task 6。

---

### Task 6: Git 最终交付（DS 成员执行）

**Files:** 无源码改动；只操作索引与远端。

**Interfaces:** Consumes 全部前序任务；Produces 一个可追溯提交 + 远端分支 SHA。

- [ ] **Step 0: 独立验收门（未通过则停）**

检查 `/root/Code/.asset-vault-feature123-20261104/planning/acceptance/` 下存在本轮独立验收记录（非作者自验），内容含：验收人、时间、验证命令与输出摘要、PASS/FAIL、被验树的 `git status --porcelain` 与关键文件 hash。缺失或 FAIL → 停止，不进入 staging。

- [ ] **Step 1: 只读核对仓库现状**

```bash
git rev-parse HEAD && git branch --show-current && git status --porcelain && git remote -v && git rev-parse --abbrev-ref @{u}
```
Expected: HEAD `cbabb82333124fd742d6caa53839d3bfa58c0afa`（若已变，记录新值）；branch `main`；tracking `origin/main`；remote `https://github.com/elysia-5201/asset-vault.git`（无内嵌 token，无需脱敏）。

- [ ] **Step 2: 分类历史 dirty（基线 35 项）与本版新增**

| 类别 | 路径 | 处理 |
|---|---|---|
| 已批准基线（本版必需） | `apps/server/src/{db/repo.ts,http/routes.ts,server.ts,services/booth.ts,services/media.ts,services/pipeline/stages.ts}`、`apps/web/src/{api.ts,types.ts,components/{ArchiveView,ItemDetail,SettingsPanel,ui}.tsx}`、`docs/CONTRACT.md`、`test/db/merge-images.test.ts` | 纳入提交 |
| 已批准新文件 | `apps/server/src/{http/media-cache-routes.ts,services/media-cache.ts}`、`apps/web/src/components/MergePreview.tsx`、`docs/desktop-release.md`、`docs/release-evidence/`、`scripts/desktop-release*`、`test/{core-smoke,release,db/booth-feedback,db/media-cache,db/thumbnail-policy,http/archive-tree-nested,http/archive-tree-readonly,web/evidence-line-labels,web/merge-preview}` | 纳入提交 |
| 本版新增 | `docs/superpowers/specs/*.md`、`docs/superpowers/plans/*.md`、本版源码与测试 | 纳入提交 |
| 排除 | `asset-vault - 快捷方式.lnk`、`test/local-main-merge-hashes-*.txt`、`data*/`、`logs/`、`*.db`、`.env*`、`apps/web/dist/`、`apps/desktop/build/`、`dist-desktop/`、`*.tgz`、`docs/verification/evidence/` | 不提交 |

未列入上表的未知 dirty 一律保全：不 staging、不提交，记录路径与 `sha256sum` 到交付报告。

- [ ] **Step 3: 显式 staging + 差异扫描**

```bash
git add <上表逐条路径>
git diff --cached --stat
git diff --cached | grep -nEi 'ghp_|github_pat_|AKIA|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|password[[:space:]]*=|token[[:space:]]*=' || echo NO_SECRET_HITS
```
只逐条路径 staging；禁止 `git add -A`/`git add .`。
Expected: `NO_SECRET_HITS`；`git status --porcelain` 中只剩排除项与未知 dirty。

- [ ] **Step 4: 从索引验证完整构建（含前端）**

```bash
IDX=$(mktemp -d "${TMPDIR:-/tmp}/av-index-check.XXXXXX")
git checkout-index -a --prefix="$IDX/"
ln -s /root/Code/asset-vault/node_modules "$IDX/node_modules"
cd "$IDX" && npx tsc --noEmit && node scripts/test.mjs && npm run build:web
```
Expected: 0 error、全部测试 PASS、`apps/web/dist/index.html` 生成（证明待提交索引自洽且前端可构建）。清理前核实 `case "$IDX" in "${TMPDIR:-/tmp}"/av-index-check.*) rm -rf "$IDX";; *) echo "REFUSE $IDX";; esac`，并保留命令日志。

- [ ] **Step 5: 提交并推送**

```bash
git commit -m "feat: import precheck, avatar loadouts, cleanup todos (schema v10)"
git push origin main
git ls-remote origin refs/heads/main
git rev-parse HEAD
```
Expected: 远端 SHA == 本地 HEAD；报告 commit、远端 URL、分支。禁止 `--force`；push 失败不重试强推，记录并停。

- [ ] **Step 6: 记录**

把 commit SHA、远端 SHA、staged 路径清单、排除项、凭据扫描结果写入交付报告。
