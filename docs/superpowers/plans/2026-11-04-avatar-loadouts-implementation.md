# 按模型搭配清单实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个模型多份清单，按 item 添加，`(清单, item)` 手动状态独立；删除/合并用墓碑 + 单调 version 挡 ABA；证据只读展示。

**Architecture:** 数据访问集中在 `db/loadouts.ts`（含 6 格合并函数）；HTTP 在 `http/routes/loadouts.ts` 自注册；UI 为独立 `LoadoutPanel` + `AddToLoadoutButton`，由总入口挂载。

**Tech Stack:** TypeScript 5.9、Fastify 5、better-sqlite3 13、React 19、`node:test` + tsx。

**Spec:** `docs/superpowers/specs/2026-11-04-avatar-loadouts-design.md`（revision-4）。

## Global Constraints

- 状态键 `(loadout_id, item_id)`；不写回 `items` 任何字段；不自动从 `item_avatars` 填充。
- `loadout_items.version` 单调、删除也递增；删除是墓碑（`deleted_at`），不物理删行、不改 key。
- `loadouts.version` 只保护 `name`/`note`/`sort`；成员增删不 bump。
- 合并按 6 格表；source 活跃转墓碑 +1、source 已墓碑不变；target 行 `version=max+1`；source 无行时 target-only no-op。
- 不新增 `AppErrorCode`；不新增 npm 依赖；不启动 Unity、不写 `project_imports`。
- 本计划不写 `apps/server/src/http/routes.ts` / `apps/server/src/db/repo.ts`；共享文件由总入口 P1-T2/P1-T3/P1-T5 串行交接。任务期不 `git add`/`commit`，只记录 diff/hash 交接。

## Review Focus

1. 删除后重加，旧 `expectedVersion` → 409（ABA）（Task 1）。
2. 合并 target 墓碑 + source 活跃 → 复活，`position=MAX(活跃行)+1`（Task 3）。
3. source 无行（target-only）→ no-op，`version`/`position`/`updated_at` 不变（Task 3）。
4. reorder 只提交可见行 → 隐藏行追加且相对顺序不变（Task 1）。
5. `stateCounts`/`visibleStateCounts`/`trashedCount` 三口径不混（Task 1）。

---

### Task 1: 清单数据访问（CRUD、墓碑、reorder、counts）

**Files:**
- Create: `apps/server/src/db/loadouts.ts`
- Test: `test/db/loadouts.test.ts`

**Interfaces:**
- Produces: `createLoadout(repo, avatarId, input: { name: string; note?: string | null }): LoadoutRow`；`listLoadouts(repo, avatarId): LoadoutSummaryRow[]`；`getLoadout(repo, id, q: { state?: LoadoutState; includeTrashedItems?: boolean; limit?: number; offset?: number }): LoadoutDetailRow`；`patchLoadout(repo, id, input: { name?: string; note?: string | null; sort?: number; expectedVersion: number }): LoadoutRow`；`deleteLoadout(repo, id): { deleted: boolean }`；`addLoadoutItems(repo, loadoutId, input: { itemIds: number[]; state?: LoadoutState; note?: string | null }): { added: number; revived: number; existing: number; items: LoadoutItemRow[] }`；`patchLoadoutItem(repo, loadoutId, itemId, input: { state?: LoadoutState; note?: string | null; position?: number; expectedVersion: number }): LoadoutItemRow`；`removeLoadoutItem(repo, loadoutId, itemId): { removed: 0 | 1 }`；`reorderLoadoutItems(repo, loadoutId, itemIds: number[]): { items: LoadoutItemRow[] }`。
- Consumes: Task 1（总入口）的 `loadouts`/`loadout_items` 表与 `repo.connection`。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openTempDb, addRoot, addItem, addAsset, addAvatar, count } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { createLoadout, addLoadoutItems, patchLoadoutItem, removeLoadoutItem, getLoadout, reorderLoadoutItems, deleteLoadout } from "../../apps/server/src/db/loadouts";

test("多清单、状态隔离、墓碑 ABA、counts 三口径", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const av = addAvatar(t.db, "Manuka"); const i1 = addItem(t.db, { title: "i1" }); const i2 = addItem(t.db, { title: "i2" });
  const L1 = createLoadout(repo, av, { name: "日常" }); const L2 = createLoadout(repo, av, { name: "活动" });
  assert.throws(() => createLoadout(repo, av, { name: "日常" }), (e: any) => e.code === "CONFLICT");
  addLoadoutItems(repo, L1.id, { itemIds: [i1, i2] });
  const it1 = patchLoadoutItem(repo, L1.id, i1, { state: "verified", expectedVersion: 1 });
  assert.equal(it1.version, 2);
  assert.equal(getLoadout(repo, L2.id, {}).items.length, 0);
  assert.equal(removeLoadoutItem(repo, L1.id, i1).removed, 1);
  assert.equal(removeLoadoutItem(repo, L1.id, i1).removed, 0);
  const revived = addLoadoutItems(repo, L1.id, { itemIds: [i1] });
  assert.equal(revived.revived, 1);
  assert.equal(revived.items[0].version, 4);
  assert.throws(() => patchLoadoutItem(repo, L1.id, i1, { state: "planned", expectedVersion: 2 }), (e: any) => e.code === "CONFLICT");
  t.db.prepare("UPDATE items SET status='trashed' WHERE id=?").run(i2);
  const d = getLoadout(repo, L1.id, {});
  assert.equal(d.stateCounts.planned + d.stateCounts.imported + d.stateCounts.verified, 2);
  assert.equal(d.visibleStateCounts.planned + d.visibleStateCounts.imported + d.visibleStateCounts.verified, 1);
  assert.equal(d.trashedCount, 1);
  assert.equal(d.items.length, 1);
  assert.deepEqual(d.items[0].evidence, { registered: false, referenced: false, verified: false, registeredAt: null, referencedAt: null, verifiedAt: null });
  const pid = repo.ensureProject("P", "/tmp/p"); repo.addProjectImport(pid, i1, null, null);
  const after = getLoadout(repo, L1.id, {});
  assert.equal(after.items[0].evidence.registered, true);
  assert.equal(after.items[0].state, "verified");
  const rowsBefore = count(t.db, "loadout_items"); getLoadout(repo, L1.id, {});
  assert.equal(count(t.db, "loadout_items"), rowsBefore);
  const assetsBefore = count(t.db, "assets"); deleteLoadout(repo, L2.id);
  assert.equal(count(t.db, "assets"), assetsBefore);
  t.close();
});

test("reorder 可见行：隐藏行追加且相对顺序不变", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const av = addAvatar(t.db, "A");
  const ids = [1, 2, 3, 4].map((n) => addItem(t.db, { title: "i" + n }));
  const L = createLoadout(repo, av, { name: "x" });
  addLoadoutItems(repo, L.id, { itemIds: ids });
  t.db.prepare("UPDATE items SET status='trashed' WHERE id=?").run(ids[1]);
  const out = reorderLoadoutItems(repo, L.id, [ids[3], ids[0], ids[2]]);
  assert.deepEqual(out.items.map((r) => r.itemId), [ids[3], ids[0], ids[2], ids[1]]);
  assert.deepEqual(out.items.map((r) => r.position), [0, 1, 2, 3]);
  t.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test test/db/loadouts.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

添加用 `INSERT … ON CONFLICT(loadout_id,item_id) DO NOTHING`；命中墓碑则复活（`deleted_at=NULL`、`version=version+1`、`position=MAX(活跃行)+1`）。删除只写墓碑 + `version+1`。PATCH 用 `WHERE loadout_id=? AND item_id=? AND version=? AND deleted_at IS NULL`，0 行 → 409。reorder 先判形状（可见行/全量/空可见集），再按数组写 position，隐藏行按原相对顺序追加。counts 三口径分开算。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import tsx --test test/db/loadouts.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 5: 记录交接（不 commit）**

```bash
mkdir -p /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup
cp --parents apps/server/src/db/loadouts.ts test/db/loadouts.test.ts /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup/
sha256sum apps/server/src/db/loadouts.ts test/db/loadouts.test.ts | tee /root/Code/.asset-vault-feature123-20261104/planning/handoff/P3-T1.sha256
git diff --cached --stat   # 必须为空
```
Expected: 备份/hash 落盘；索引/HEAD 未变。

---

### Task 2: 清单 HTTP 端点

**Files:**
- Create: `apps/server/src/http/routes/loadouts.ts`
- Test: `test/http/loadouts-routes.test.ts`

**Interfaces:**
- Produces: `registerLoadoutRoutes(app, deps): void`，注册 `GET/POST /api/avatars/:id/loadouts`、`GET/PATCH/DELETE /api/loadouts/:id`、`POST /api/loadouts/:id/items`、`PATCH/DELETE /api/loadouts/:id/items/:itemId`、`POST /api/loadouts/:id/items/reorder`。
- Consumes: Task 1 全部函数。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { openTempDb, addItem, addAvatar } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerLoadoutRoutes } from "../../apps/server/src/http/routes/loadouts";

test("创建/添加/改状态/删除/重排 走真实 HTTP", async () => {
  const t = openTempDb(); const repo = new Repo(t.db); const av = addAvatar(t.db, "A"); const it = addItem(t.db, { title: "i" });
  const app = Fastify({ logger: false }); registerLoadoutRoutes(app as any, { repo, log: () => {} } as any);
  const c = await app.inject({ method: "POST", url: "/api/avatars/" + av + "/loadouts", payload: { name: "日常" } });
  assert.equal(c.statusCode, 201); const L = JSON.parse(c.body).loadout;
  assert.equal((await app.inject({ method: "POST", url: "/api/avatars/" + av + "/loadouts", payload: { name: "日常" } })).statusCode, 409);
  const a = await app.inject({ method: "POST", url: "/api/loadouts/" + L.id + "/items", payload: { itemIds: [it] } });
  assert.equal(a.statusCode, 200); assert.equal(JSON.parse(a.body).added, 1);
  const p = await app.inject({ method: "PATCH", url: "/api/loadouts/" + L.id + "/items/" + it, payload: { state: "verified", expectedVersion: 1 } });
  assert.equal(p.statusCode, 200); assert.equal(JSON.parse(p.body).item.state, "verified");
  assert.equal((await app.inject({ method: "PATCH", url: "/api/loadouts/" + L.id + "/items/" + it, payload: { state: "planned", expectedVersion: 1 } })).statusCode, 409);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/loadouts/" + L.id + "/items/" + it })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/loadouts/" + L.id })).statusCode, 200);
  t.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test test/http/loadouts-routes.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

参数校验：`name` 1..80、`note` ≤500、`itemIds` 1..200、`limit` ≤500；错误用 `INVALID_INPUT`/`NOT_FOUND`/`CONFLICT`，子码放 `details.code`。GET 纯读。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import tsx --test test/http/loadouts-routes.test.ts`
Expected: PASS。

- [ ] **Step 5: 记录交接（不 commit）**

```bash
mkdir -p /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup
cp --parents apps/server/src/http/routes/loadouts.ts test/http/loadouts-routes.test.ts /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup/
sha256sum apps/server/src/http/routes/loadouts.ts test/http/loadouts-routes.test.ts | tee /root/Code/.asset-vault-feature123-20261104/planning/handoff/P3-T2.sha256
git diff --cached --stat   # 必须为空
```
Expected: 备份/hash 落盘；索引/HEAD 未变。

---

### Task 3: 合并 6 格表

**Files:**
- Modify: `apps/server/src/db/loadouts.ts`（新增 `mergeLoadoutItemsTx`）
- Test: `test/db/loadouts-merge.test.ts`

**Interfaces:**
- Produces: `mergeLoadoutItemsTx(db: Database.Database, sourceItemId: number, targetItemId: number, at: string): { conflicts: number; revived: number; moved: number; bothTombstone: number; noop: number }`。
- Consumes: Task 1 的表结构。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openTempDb, addItem, addAvatar, NOW } from "../schema/_db";
import { mergeLoadoutItemsTx } from "../../apps/server/src/db/loadouts";

const row = (db: any, l: number, i: number) => db.prepare("SELECT * FROM loadout_items WHERE loadout_id=? AND item_id=?").get(l, i) as any;

test("6 格表：target 活跃/墓碑/无行 × source 活跃/墓碑", () => {
  const t = openTempDb(); const av = addAvatar(t.db, "A");
  const S = addItem(t.db, { title: "S" }); const T = addItem(t.db, { title: "T" });
  const mk = (name: string) => Number(t.db.prepare("INSERT INTO loadouts(avatar_id,name,sort,version,created_at,updated_at) VALUES (?,?,0,1,?,?)").run(av, name, NOW, NOW).lastInsertRowid);
  const put = (l: number, i: number, v: number, del: string | null) => t.db.prepare("INSERT INTO loadout_items(loadout_id,item_id,state,position,version,created_at,updated_at,deleted_at) VALUES (?,?, 'planned', 0, ?, ?, ?, ?)").run(l, i, v, NOW, NOW, del);
  const L1 = mk("L1"); put(L1, T, 2, null); put(L1, S, 5, null);
  const L2 = mk("L2"); put(L2, T, 3, NOW); put(L2, S, 4, null);
  const L3 = mk("L3"); put(L3, T, 7, null);
  const L4 = mk("L4"); put(L4, S, 9, NOW);
  const r = mergeLoadoutItemsTx(t.db, S, T, NOW);
  assert.equal(row(t.db, L1, T).version, 6); assert.equal(row(t.db, L1, T).deleted_at, null);
  assert.equal(row(t.db, L1, S).version, 6); assert.ok(row(t.db, L1, S).deleted_at);
  assert.equal(row(t.db, L2, T).version, 5); assert.equal(row(t.db, L2, T).deleted_at, null);
  assert.equal(row(t.db, L2, S).version, 5); assert.ok(row(t.db, L2, S).deleted_at);
  assert.equal(row(t.db, L3, T).version, 7); assert.equal(row(t.db, L3, T).deleted_at, null);
  assert.equal(row(t.db, L4, S).version, 9); assert.ok(row(t.db, L4, S).deleted_at);
  assert.equal(r.noop, 2);
  t.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test test/db/loadouts-merge.test.ts`
Expected: FAIL —— 函数不存在。

- [ ] **Step 3: 实现**

按 spec §9.1 六格逐格实现；任何分支都不 `UPDATE loadout_items SET item_id`；更新条件带 `version=?`（活跃行再加 `deleted_at IS NULL`）；source 无行时 target 活跃/墓碑均 no-op。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import tsx --test test/db/loadouts-merge.test.ts`
Expected: PASS。

- [ ] **Step 5: 记录交接（不 commit）**

```bash
mkdir -p /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup
cp --parents apps/server/src/db/loadouts.ts test/db/loadouts-merge.test.ts /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup/
sha256sum apps/server/src/db/loadouts.ts test/db/loadouts-merge.test.ts | tee /root/Code/.asset-vault-feature123-20261104/planning/handoff/P3-T3.sha256
git diff --cached --stat   # 必须为空
```
Expected: 备份/hash 落盘；索引/HEAD 未变。

---

### Task 4: 搭配面板与“加入清单”

**Files:**
- Create: `apps/web/src/components/LoadoutPanel.tsx`
- Create: `apps/web/src/components/AddToLoadoutButton.tsx`
- Create: `apps/web/src/loadout-view.ts`（`stateLabel`、`countsCaption`、`reorderPayload`）
- Test: `test/web/loadout-view.test.ts`

**Interfaces:**
- Produces: `stateLabel(s: LoadoutState): string`（`准备使用`/`已导入（手动）`/`已验证（手动）`）；`countsCaption(c: { stateCounts: ...; trashedCount: number }): string`；`reorderPayload(visibleIds: number[], hiddenIds: number[]): number[]`。
- Consumes: Task 2 的端点与总入口的 `Loadout` 类型。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { stateLabel, countsCaption, reorderPayload } from "../../apps/web/src/loadout-view";

test("状态文案带“手动”限定；counts 文案注明含回收站", () => {
  assert.equal(stateLabel("planned"), "准备使用");
  assert.equal(stateLabel("imported"), "已导入（手动）");
  assert.equal(stateLabel("verified"), "已验证（手动）");
  assert.match(countsCaption({ stateCounts: { planned: 3, imported: 0, verified: 0 }, trashedCount: 2 }), /含回收站条目/);
  assert.deepEqual(reorderPayload([3, 1], [2]), [3, 1, 2]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test test/web/loadout-view.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

面板：清单选择器 + 新建/改名/删除（确认“只删清单，不删素材”）+ 条目列表（状态 chip、证据列只读、备注）+ 拖拽只提交可见行。`AddToLoadoutButton`：选模型 → 选清单 → 添加，不自动添加。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import tsx --test test/web/loadout-view.test.ts`
Expected: PASS。

- [ ] **Step 5: 记录交接（不 commit）**

```bash
mkdir -p /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup
cp --parents apps/web/src/components/LoadoutPanel.tsx apps/web/src/components/AddToLoadoutButton.tsx apps/web/src/loadout-view.ts test/web/loadout-view.test.ts /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup/
sha256sum apps/web/src/components/LoadoutPanel.tsx apps/web/src/components/AddToLoadoutButton.tsx apps/web/src/loadout-view.ts test/web/loadout-view.test.ts | tee /root/Code/.asset-vault-feature123-20261104/planning/handoff/P3-T4.sha256
git diff --cached --stat   # 必须为空
```
Expected: 备份/hash 落盘；索引/HEAD 未变。
