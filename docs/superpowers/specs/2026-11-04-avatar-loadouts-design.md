# 按模型搭配清单设计（Feature 2）

- 日期：2026-11-04（revision-4）
- 状态：用户书面设计已批准（m00868，2026-11-04）；待实施计划确认；未开始实施
- 范围：一个模型（avatar）可有多份搭配清单；按 item 添加；`(清单, item)` 手动状态独立；与 Unity 导入/引用/校验证据分层
- 读者：用户、lead、实现者、验证者
- 关联：总览 `2026-11-04-feature123-design.md`；盘点证据 `/root/Code/.asset-vault-feature123-20261104/discovery/workflow/report.md`
- 实施计划：[`../plans/2026-11-04-avatar-loadouts-implementation.md`](../plans/2026-11-04-avatar-loadouts-implementation.md)
- 修订：revision-1 修 P2-5（删除重加 ABA）、P3-3（counts 维度混用）、P3-4（reorder 覆盖隐藏行）、P3-8（loadout version 保护范围）；revision-2 修 N1（merge 到 target 墓碑/无行的 6 格表、source 墓碑保留、version=max+1 防两端 ABA）、P3-5 局部（includeTrashedItems 命名、空可见集 reorder、复活 position、stateCounts 含隐藏项）；revision-3 局部澄清 P3-1（source 已墓碑不递增）、P3-2（mergeItems 对所有含 S/T 清单逐个应用 6 格表；link-booth 仍不迁清单）、P3-8（position MAX 只算活跃行）与错误子码 details.code。清单粒度/状态枚举/多清单已由用户 m00689 批准，不再作为待选项。revision-4 按 review-r3 的 P3-1/P3-2 局部澄清：把“同时含 S 或 T”统一为“含 S 或 T（至少一个）”；6 格表补 source 无行（target-only 活跃/墓碑均 no-op）与两边无行 no-op；补 B9j–B9m 正例。

> 本文只写设计，不改产品代码、不改 `packages/core/src/contracts.ts`、`apps/server/src/db/schema.sql`、`apps/server/src/db/migrate.ts`、`docs/api.md`。文中的 DDL/端点/字段都是**建议**，实施前需书面 spec 与 plan 分别批准。

## 1. 目标与不变量

### 1.1 目标

让用户为每个模型维护“这次准备用哪些素材”的清单：

- 一个模型可以有多份清单（日常 / 活动 / 企划），清单名在模型内唯一；
- 清单按 **item** 添加，不按 asset/单元添加（v1 粒度，已批准）；
- 同一 item 在不同清单、不同模型下的状态**互不影响**；
- 清单状态是**用户手动声明**，与 Unity 的登记/实际引用/导入校验证据**分列展示**，互不自动改写。

### 1.2 硬不变量

- **状态键是 `(loadout_id, item_id)`**，不写回 `items` 的任何字段。
- **同一 item 多模型不串**：item 在模型 A 的清单里是“已验证”，不影响模型 B 的清单；同一模型的两份清单也互不影响。
- **兼容关系 ≠ 使用意图**：`item_avatars`（`schema.sql:168-177`）是“适配/兼容”关系，不是“这个模型准备用哪些素材”。清单成员必须由用户显式添加，**不自动从 `item_avatars` 填充**。
- **声明与证据分层**：清单状态是声明；`project_imports` 是登记（不代表工程里真的有）；`project_refs` 是实际引用证据；`import_runs.verified` 是导入后校验结论。四者分列，任何证据都不静默改写清单状态，任何清单状态也不伪造证据。
- **不删除素材**：删除清单/移除清单项只删关系行，不删 item/asset/文件。
- **不启动 Unity**：清单 CRUD 不调用 Unity、不建导入计划、不写 `project_imports`。
- **版本号单调不复位**：`loadout_items.version` 在删除时也递增，重加再递增；合并时 `version = max(两边 version) + 1`；旧客户端持有的任一边 `expectedVersion` 永远匹配不到合并后的行（防两端 ABA）。
- **不物理删除、不改 key**：删除、合并、重加都不物理删除 `loadout_items` 行，也不把 source 行的 `item_id` 改成 target；source 行一律转墓碑，保留 `(loadout_id,item_id)` 与单调 `version`，避免同一 source key 重加时 version 复位。

## 2. 现状事实（只读核对）

| 事实 | 证据 |
|---|---|
| `avatars` 是模型白名单；`avatar_aliases` 是别名 | `apps/server/src/db/schema.sql:146-166` |
| `item_avatars` 是条目级适配关系，`match` ∈ any/all/exclude，`source` ∈ auto/manual/confirmed | `apps/server/src/db/schema.sql:168-177`；`packages/core/src/contracts.ts:146` |
| 自动匹配保护 manual/confirmed 行，只覆盖 `item_avatars` | `apps/server/src/services/match.ts:47-48`、`:70-76` |
| `collections`/`collection_items` 是“同商品套装”归组，不是按模型的使用清单；`position` 写入恒为 0 | `apps/server/src/db/schema.sql:202-211`；`apps/server/src/db/repo.ts:1034-1060` |
| `project_imports` 是“登记导入”，不代表工程里真的有 | `apps/server/src/db/schema.sql:218-225`；`docs/api.md:114` |
| `project_refs` 是扫描求交后的实际引用证据 | `apps/server/src/db/schema.sql:229-239`；`docs/api.md:161-179` |
| `import_runs.verified` 是导入后校验结论；状态机在 `structure.ts` | `apps/server/src/db/schema.sql:514-528`；`apps/server/src/services/structure.ts:330-340` |
| 工作台状态文案与“不自造第二套状态”纪律 | `apps/web/src/components/AvatarWorkbench.tsx:21-34`、`:56-74` |
| 条目详情已有“套装/合并”区与手动适配模型入口 | `apps/web/src/components/ItemDetail.tsx:475-542`、`:756-804` |
| 条目软删/恢复 | `apps/server/src/http/routes.ts:341-348` |
| 模型删除 | `apps/server/src/http/routes.ts:682-684` |
| 合并条目会迁 asset、并集 `item_avatars`、软删 source | `apps/server/src/db/repo.ts:576-654` |
| 当前 `SCHEMA_VERSION = 9` | `apps/server/src/db/migrate.ts:11` |

## 3. 术语与命名

| 词 | 本文含义 | 与现有词的区别 |
|---|---|---|
| 搭配清单 / loadout | 某个模型的一份“准备使用”清单 | 不是 `collections`（同商品套装），不是工作台的“导入清单”（勾选单元→计划） |
| 清单项 / loadout item | `(loadout, item)` 一行 | 不是 asset，不是 unit |
| 清单状态 | `planned` / `imported` / `verified`，**手动声明** | 不是 `project_imports` 登记，不是 `project_refs` 引用，不是 `import_runs.verified` 校验 |
| 工程证据 | 登记/引用/校验三类只读数据 | 不自动写清单状态 |

UI 文案必须带范围限定：清单状态显示为“清单：准备使用 / 已导入 / 已验证（手动）”；证据列显示为“工程登记 / 实际引用 / 导入校验（只读）”。

## 4. 方案与取舍

### 4.1 候选方案

- **A（选用）新表 `loadouts` + `loadout_items` + 新端点 + 新面板**：语义干净，状态隔离天然成立，可查询/可筛选/可测试；不污染 `collections` 与工作台。
- **B 复用 `collections`（`kind='loadout'`）+ JSON 状态**：迁移小，但状态不是关系型，无法按状态/模型高效筛选；`collections` 语义被污染；并发写 JSON 易丢；不选。
- **C 纯前端 localStorage**：零后端，但不持久、不跨设备、不可查询、无法与证据对账；不选。

### 4.2 选择理由

- A 的代价是 schema 变更（需 v10 单一 owner 批准），但这是“按模型多清单 + 每项独立状态”的最小正确模型。
- A 不触碰 `collections`、`project_imports`、`project_refs`、`import_runs` 的既有语义；证据只读展示。
- A 的 item 粒度与用户已批准的“按 item 添加”一致；单元级粒度留到未来（不在本轮重开）。

## 5. 数据模型（建议，未执行）

### 5.1 `loadouts`

```sql
CREATE TABLE IF NOT EXISTS loadouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  avatar_id INTEGER NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  note TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (avatar_id, name)
);
CREATE INDEX IF NOT EXISTS ix_loadouts_avatar ON loadouts(avatar_id, sort, id);
```

- `avatar_id` 外键 → `avatars(id)`；模型删除时级联删除清单（见 §9）。
- `name` 在模型内唯一；`COLLATE NOCASE` 只折叠 ASCII 大小写，中日文按原样比较。
- `version` 用于乐观并发（PATCH 必须带 `expectedVersion`）。
- **`version` 的保护范围（P3-8）**：只保护 `name`/`note`/`sort` 这三个清单自身字段。**成员增删、成员状态变更不 bump `loadouts.version`**；成员并发由 `loadout_items.version` 逐行保护。UI 不得用 `loadouts.version` 当作“整份清单快照”的并发令牌。

### 5.2 `loadout_items`

```sql
CREATE TABLE IF NOT EXISTS loadout_items (
  loadout_id INTEGER NOT NULL REFERENCES loadouts(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','imported','verified')),
  note TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (loadout_id, item_id)
);
CREATE INDEX IF NOT EXISTS ix_loadout_items_item ON loadout_items(item_id);
CREATE INDEX IF NOT EXISTS ix_loadout_items_state ON loadout_items(loadout_id, state, position, item_id);
CREATE INDEX IF NOT EXISTS ix_loadout_items_live ON loadout_items(loadout_id, deleted_at, position, item_id);
```

- 主键 `(loadout_id, item_id)` 保证同一清单内同一 item 只有一行；同一 item 可在多个清单/多个模型下各有一行，状态独立。
- `state` 是手动声明，**没有状态机转移表**：任意状态可改为任意状态；服务端只校验枚举。
- `position` 用于清单内排序；默认 0，按 `position ASC, item_id ASC` 稳定排序。
- `version` 用于乐观并发，**单调递增、删除也不复位**。
- `deleted_at` 是**墓碑**（P2-5）：删除不物理删行，而是 `deleted_at=now(), version=version+1`；重加同一 `(loadout,item)` 时把 `deleted_at` 置回 NULL、`version=version+1`、`position=MAX(position)+1`（复活行放末尾，P3 局部；MAX 只算该清单的活跃行 `deleted_at IS NULL`）。这样旧客户端手里的 `expectedVersion` 永远匹配不到重加后的行。
- **合并也不物理删除 source 行**（N1）：合并时 source 行转墓碑（`deleted_at=now(), version=version+1`），target 行按 §9 的 6 格表处理；source 无行时 target-only 不处理（§9.1）；任何分支都不执行 `UPDATE loadout_items SET item_id=...`，因此不会触发 `PRIMARY KEY(loadout_id,item_id)` 冲突，也不会让 source key 的 version 复位。

### 5.3 迁移与回退

- **单一 owner**：`SCHEMA_VERSION` 9 → 10 只 bump 一次；三份 spec 的表由同一个迁移 owner 一次性落地（见总览 §4）。本 spec 不拥有 `migrate.ts`。
- 幂等：`CREATE TABLE IF NOT EXISTS`；不改既有表、不加列。
- **备份**：迁移前停服务，复制 `vault.db`、`vault.db-wal`、`vault.db-shm`。
- **回退**：停服务 → 恢复三件备份 → 启动旧二进制。**不声称无损 downgrade**：旧代码会忽略多出的表，但会把 `schema_meta.version` 写回 9；只能靠恢复备份。
- 迁移验收：v9 fixture → 迁移 → 表/索引存在、`schema_meta.version=10`、既有行数不变；再跑一次 no-op。

## 6. API 设计（建议，未执行）

### 6.1 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/avatars/:id/loadouts` | 纯读；`{loadouts: [{id, avatarId, name, note, sort, itemCount, stateCounts: {planned, imported, verified}, trashedCount, updatedAt}]}`；按 `sort, id`；`itemCount` 只计 `deleted_at IS NULL` 的行 |
| POST | `/api/avatars/:id/loadouts` | `{name, note?}` → 201 `{loadout}`；`name` 1..80 字符、`note` ≤500；同名 → 409 CONFLICT；空名 → 400 |
| GET | `/api/loadouts/:id?state=planned|imported|verified&limit=&offset=&includeTrashedItems=0|1` | 纯读；`{loadout, total, stateCounts: {planned, imported, verified}, visibleStateCounts: {planned, imported, verified}, trashedCount, items: [...]}`；`total` 是应用 `state`/`includeTrashedItems` 后的行数；`stateCounts` 按整份清单（`deleted_at IS NULL`）统计，**包含 item 在回收站的行**；`visibleStateCounts` 只统计 `includeTrashedItems=0` 时可见的行（item 不在回收站）；`trashedCount` 是 item 在回收站的行数；默认 `includeTrashedItems=0`；limit 默认 100、上限 500；按 `position, item_id` |
| PATCH | `/api/loadouts/:id` | `{name?, note?, sort?, expectedVersion}` → `{loadout}`；CAS 失败/同名 → 409；**只保护 name/note/sort** |
| DELETE | `/api/loadouts/:id` | → `{deleted}`；级联删 `loadout_items`；不删 item/asset |
| POST | `/api/loadouts/:id/items` | `{itemIds: number[] (1..200), state?, note?}` → `{added, revived, existing, items}`；`state` 只作用于新行/复活行（默认 `planned`）；幂等添加，不覆盖已有活跃行的状态 |
| PATCH | `/api/loadouts/:id/items/:itemId` | `{state?, note?, position?, expectedVersion}` → `{item}`；CAS 失败 → 409；`deleted_at IS NOT NULL` 的行视为不存在（404） |
| DELETE | `/api/loadouts/:id/items/:itemId` | → `{removed: 0|1}`；墓碑删除（`deleted_at` + `version+1`）；已删除再删 → `removed:0`，幂等 |
| POST | `/api/loadouts/:id/items/reorder` | `{itemIds: number[]}` → `{items}`；见 §6.2 的两种合法形状 |

### 6.2 响应、错误与 reorder

- 成功：200/201；删除返回 `{deleted}`/`{removed}`。
- 错误：`400 INVALID_INPUT`（空名、非法 state、`itemIds` 空且可见集非空、reorder 形状非法）；`404 NOT_FOUND`（avatar/loadout/item 不存在，或清单项已墓碑）；`409 CONFLICT`（同名、CAS 失败）；`500` 未预期。
- 不新增外层 `AppErrorCode`；复用现有 `NOT_FOUND/INVALID_INPUT/CONFLICT`。子码（如有）放 additive 可选 `details.code`，不新增外层 enum；若需给 `AppError` 加可选 `details` 字段，属 `contracts.ts` 的 additive 变更，列入限定冻结面，需批准。
- 分页：`limit/offset`，稳定排序带唯一兜底 `item_id`；`total` 与 `stateCounts`/`trashedCount` 分开返回。
- **counts 维度拆分（P3-3）**：`stateCounts` 只统计 `loadout_items.state`（planned/imported/verified），按整份清单（`deleted_at IS NULL`）统计，**包含 item 在回收站的行**；`visibleStateCounts` 只统计当前可见行（item 不在回收站）；`trashedCount` 统计“清单项对应的 item 当前 `status='trashed'`”的行数。三者维度不同，不再混在一个 `counts` 对象里。UI 的 tab 数字用 `visibleStateCounts`，需要“整份清单”口径时用 `stateCounts`，并在文案注明“含回收站条目”。
- **`includeTrashedItems` 命名（P3 局部）**：参数只指“item 当前在回收站”，**不指** `loadout_items.deleted_at` 墓碑；墓碑行在任何取值下都不返回。旧名 `includeTrashed` 不再使用。
- **reorder 的两种合法形状（P3-4）**：
  1. **可见行重排**（默认 UI 用法）：`itemIds` 恰好覆盖当前 `includeTrashedItems=0` 可见的全部行。服务端把可见行按数组顺序写 `position=0..n-1`；隐藏行（item 在回收站）保持它们原来的相对顺序，追加为 `n..n+m-1`。客户端不需要先拉隐藏行。
  2. **全量重排**：`itemIds` 恰好覆盖该清单全部活跃行（含回收站 item）。服务端按数组顺序写 `position=0..n+m-1`。
  - **空可见集（P3 局部）**：若当前没有可见行（全部 item 在回收站），`itemIds=[]` 是合法 no-op（200，position 不变）；若可见集非空而 `itemIds=[]` → 400 `INVALID_INPUT`。
  - 其它形状（少行、多行、含不属于该清单的 item、含墓碑行）→ 400 `INVALID_INPUT`。
  - 响应返回重排后的完整活跃行（含隐藏行），便于 UI 校验。

### 6.3 证据字段（只读）

`GET /api/loadouts/:id` 的每个 item 带：

```json
{
  "evidence": {
    "registered": true,
    "referenced": false,
    "verified": false,
    "registeredAt": "…",
    "referencedAt": null,
    "verifiedAt": null
  }
}
```

- `registered` = 存在 `project_imports` 行（任意工程），时间取 `MAX(imported_at)`；`referenced` = 存在 `project_refs` 行，时间取 `MAX(scanned_at)`；`verified` = 存在 `import_runs r JOIN import_plans p ON p.id=r.plan_id WHERE p.item_id=? AND r.status='verified'`，时间取 `MAX(r.finished_at)`。
- 这些字段**只读**；服务端不因证据变化写 `loadout_items.state`。
- 证据查询按 `item_id` 聚合，不按清单；同一 item 在不同清单看到同一份证据。

## 7. UI 设计

### 7.1 入口

- 左侧 Avatar 轨（`AvatarRail`）增加“搭配”入口；选中模型后显示该模型的清单选择器。
- `ItemDetail` 增加“加入搭配清单…”按钮：选择模型 → 选择清单 → 添加；不自动添加。
- 工作台（`AvatarWorkbench`）保持“导入清单”语义，不混入搭配清单；两者文案分开。

### 7.2 面板

- 清单选择器：模型内多份清单；新建/改名/删除；删除前确认“只删清单，不删素材”。
- 条目列表：每行显示 item 标题、清单状态 chip、证据列（登记/引用/校验，只读）、备注。
- 状态 chip 文案：`准备使用` / `已导入（手动）` / `已验证（手动）`；证据列文案：`工程登记` / `实际引用` / `导入校验`。
- 冲突提示：清单状态与证据不一致时显示“清单声明与工程证据不一致（不会自动改写）”，不自动修正。
- 回收站 item：默认隐藏，计数显示 `trashedCount`；打开“显示回收站”后可见，标“回收站”。
- 拖拽排序：只提交可见行（§6.2 形状 1），不需要先加载隐藏行。

### 7.3 文案纪律

- 禁止把清单状态叫“已导入/已验证”而不带“清单/手动”限定；禁止把证据叫“清单状态”。
- 禁止“自动同步 Unity 状态”；证据只读。

## 8. 并发、事务、一致性

- 创建清单：单条 `INSERT`；唯一冲突 → 409；创建 + 审计用 `transactionIfNeeded`。
- 添加 item：`INSERT … ON CONFLICT(loadout_id,item_id) DO NOTHING`；若命中墓碑行则 `UPDATE … SET deleted_at=NULL, state=?, note=?, position=MAX(position)+1, version=version+1, updated_at=?`（MAX 只算活跃行）；返回 `added/revived/existing`；不覆盖已有活跃行的 state/note/position。
- 合并清单项（N1）：读取 `(L,S)` 与 `(L,T)` 两行后，按 §9 的 6 格表计算；更新条件带 `version=?`（活跃行再加 `deleted_at IS NULL`），0 行 → 409/重试，不覆盖并发修改。合并事务内不执行 `UPDATE loadout_items SET item_id=...`，source 行只转墓碑。
- 修改清单/清单项：`UPDATE … WHERE id=? AND version=?`（清单）或 `WHERE loadout_id=? AND item_id=? AND version=? AND deleted_at IS NULL`（清单项）的 CAS；0 行 → 409。**不声称线程安全**：实际保证是单进程 + better-sqlite3 同步执行 + SQLite WAL + `busy_timeout=5000`；跨进程并发不在保证范围。
- 删除清单项：`UPDATE … SET deleted_at=?, version=version+1 WHERE loadout_id=? AND item_id=? AND deleted_at IS NULL`；0 行 → `removed:0`（幂等）。
- 删除清单：单条 `DELETE`；级联由 FK 完成；删除 + 审计同事务。
- 审计：创建/改名/删除/状态变更/添加/移除/复活都写 `audit_log`（`repo.ts:1349`）。
- **ABA 说明（P2-5）**：只靠 `created_at` 毫秒时间戳不够（同毫秒可复现，且删除重加会得到新时间戳但旧客户端仍可能猜中）。本设计用“墓碑 + 单调 version”：删除 `version+1`、重加再 `version+1`，旧 `expectedVersion` 必然 0 行 → 409。所有 mutation 的身份都是 `(loadout_id, item_id, version)`，不引入额外历史表。

## 9. 生命周期与清理

| 事件 | 影响 |
|---|---|
| item 软删（`status='trashed'`） | `loadout_items` 保留；`GET` 默认隐藏，`trashedCount` 计数；恢复后原样可见 |
| item 恢复 | 原样可见 |
| `mergeItems(source→target)` | 在合并事务内对**每个含 S 或 T（至少一个）的清单**按下方 **6 格表**处理 `loadout_items`；不物理删除 source 行、不改 source key；target 行 version 严格上升，source 活跃行转墓碑时 +1、source 已是墓碑则原样保留；审计与业务更新同事务 |
| item 硬删（当前无产品入口） | `ON DELETE CASCADE` 删除清单项；未来加永久删除入口时 UI 必须提示“该条目在 N 份搭配清单中” |
| 模型删除（`routes.ts:682`） | `loadouts` 级联删除 → `loadout_items` 级联删除；UI 必须提示“该模型有 N 份搭配清单” |
| 清单删除 | 只删清单与清单项；不删 item/asset/文件 |

### 9.1 合并的 6 格表（N1）

设清单 L、source item S、target item T；每行有“活跃”（`deleted_at IS NULL`）、“墓碑”（`deleted_at IS NOT NULL`）、“无行”三种状态。`mergeItems` 对**每个含 S 或 T（至少一个）的清单 L** 分别应用本表；S、T 都不含的清单不受影响。下表六格处理 **source 存在（活跃/墓碑）** 的情况；**source 无行**时：target 活跃/墓碑均 no-op（不碰 `version`/`position`/`updated_at`），两边都无行也 no-op。link-booth 仍只移资产、软删本地 item，不迁 `loadout_items`。

| target \ source | source 活跃 | source 墓碑 |
|---|---|---|
| **target 活跃** | 保留 target 的 state/note/position；`target.version = max(T.version, S.version) + 1`；source 行转墓碑（`deleted_at=now, version=S.version+1`）；不物理删除 | 保留 target；`target.version = max(T.version, S.version) + 1`；source 墓碑原样保留（不删、不改 key） |
| **target 墓碑** | 复活 target：`deleted_at=NULL`，state/note/position 取 source，`position=MAX(position)+1`（MAX 只算活跃行），`version=max(T.version,S.version)+1`；source 行转墓碑（`version=S.version+1`）；不物理删除 | 两边都保持墓碑；`target.version=max(T.version,S.version)+1`；source 墓碑原样保留；不产生活跃行 |
| **target 无行** | 新建 target 行：state/note/position 取 source，`version=S.version+1`；source 行转墓碑（`version=S.version+1`）；不物理删除 | 不新建 target；source 墓碑原样保留；no-op |

规则：

- **不移动 key**：任何分支都不执行 `UPDATE loadout_items SET item_id=...`。target 无行时新建 target 行，source 行保留为墓碑；因此不会触发 `PRIMARY KEY(loadout_id,item_id)` 冲突，也不会让 source key 的 version 复位（source ABA）。
- **version 严格上升**：target 行（活跃/墓碑/新建）的 version 都严格大于合并前 target 与 source 的 version；source **活跃**行转墓碑时 `version=S.version+1`；source **已是墓碑**时原样保留（version 不变）。旧客户端持有的任一边 `expectedVersion` 都匹配不到合并后的活跃行；墓碑行被 CAS 的 `deleted_at IS NULL` 视为不存在。
- **source 无行（target-only）**：target 活跃或墓碑都 no-op；不 bump `target.version`、不改 `position`/`updated_at`、不写审计。两边都无行同样 no-op。
- **source 墓碑保留**：source 行一律转墓碑，不物理删除；以后重加 S 时按 §5.2 复活，`version=version+1`，不会回到 1。
- **state/note/position**：target 活跃时保留 target 的 state/note/position（target 赢，已批准）；target 墓碑复活时取 source 的 state/note/position，position 放末尾；target 无行新建时取 source 的 state/note/position，position 保留 source 的位置。
- **排序碰撞**：position 允许重复；读取顺序固定为 `position ASC, item_id ASC`，碰撞由 `item_id` 兜底，结果是确定的。合并/复活不承诺 position 全局唯一。
- **CAS**：读取两行后，更新条件带 `version=?`（活跃行再加 `deleted_at IS NULL`）；0 行 → 409/重试，不覆盖并发修改。
- **审计**：`loadout.merge_conflict`（target 活跃 + source 活跃）、`loadout.merge_revive`（target 墓碑 + source 活跃）、`loadout.merge_both_tombstone`、`loadout.merge_move`（target 无行 + source 活跃）、`loadout.merge_noop`（target 无行 + source 墓碑）；审计与业务更新同事务。

## 10. 验收（可执行的正反例）

| # | 场景 | 期望 |
|---|---|---|
| B1 | 同一模型建 2 份清单 | 都成功；同名 → 409；空名 → 400 |
| B2 | 同一 item 在 2 份清单设不同状态 | 两行独立；互不影响 |
| B3 | 同一 item 在模型 A、模型 B 的清单 | 两行独立；A 的“已验证”不影响 B 的“准备使用” |
| B4 | 重启服务 | 清单与状态仍在（落库，不是 localStorage） |
| B5 | 添加 item 两次 | 第二次返回 `existing`，不覆盖已有 state/note |
| B6 | 修改状态带旧 `expectedVersion` | 409 CONFLICT；不覆盖 |
| B7 | 删除清单 | 清单项级联删除；item/asset/文件仍在 |
| B8 | 删除模型 | 清单级联删除；UI 提示；item/asset 不受影响 |
| B9 | 合并 source→target，同一清单已有 target 活跃行 | 保留 target 的 state/note/position；target.version=max+1；source 行转墓碑（不物理删除）；审计有冲突记录 |
| B9b | target 只有墓碑行、source 活跃 | 复活 target：deleted_at=NULL，state/note/position 取 source，position=MAX+1，version=max+1；source 转墓碑；旧 target/source expectedVersion 都 409 |
| B9c | target 墓碑、source 墓碑 | 两边都保持墓碑；target.version=max+1；不产生活跃行；source 墓碑不动 |
| B9d | target 活跃、source 活跃 | target 保留 state/note/position，version=max+1；source 转墓碑；旧 source expectedVersion 409 |
| B9e | target 活跃、source 墓碑 | target.version=max+1；source 墓碑原样保留；不新建行 |
| B9f | target 无行、source 活跃 | 新建 target 行（state/note/position 取 source，version=S.version+1）；source 转墓碑；source key 重加时 version 不复位 |
| B9g | target 无行、source 墓碑 | 不新建 target；source 墓碑原样保留；no-op |
| B9h | source 已是墓碑，合并后 | source.version 不变；target 存在时 target.version=max+1；不产生活跃行 |
| B9i | L1、L2 都含 S 或 T（至少一个），L3 都不含 | L1/L2 各自应用 6 格表；L3 不变；link-booth 不迁清单 |
| B9j | 清单只有 source 活跃行（target 无行） | 新建 target 行（state/note/position 取 source，version=S.version+1）；source 转墓碑；不物理删除 |
| B9k | 清单只有 source 墓碑行（target 无行） | 不新建 target；source 墓碑原样保留；no-op |
| B9l | 清单只有 target 活跃行（source 无行） | no-op：target.version/position/updated_at 不变；不写审计 |
| B9m | 清单只有 target 墓碑行（source 无行） | no-op：target.version/position/updated_at 不变；不写审计 |
| B10 | 证据变化（登记/引用/校验） | 清单状态不变；证据列更新 |
| B11 | 清单状态变化 | 不写 `project_imports`/`project_refs`/`import_runs` |
| B12 | 全程不调用 Unity | 无 Unity 请求、无导入计划、无 staging |
| B13 | `item_avatars` 有 any/exclude 行 | 不自动加入清单；必须用户显式添加 |
| B14 | GET 端点 | 纯读；前后 DB 行数不变 |
| B15 | 删除 (L,I) 后重加，旧客户端用删除前的 `expectedVersion` PATCH | 409 CONFLICT；不覆盖新行（ABA 挡住） |
| B16 | 删除 (L,I) 再删一次 | `removed:0`；`version` 不再递增 |
| B17 | 重加墓碑行 | `revived`；`deleted_at=NULL`；`version` 比删除前大 2；`position=MAX(活跃行)+1` |
| B17c | 清单有墓碑行与活跃行，重加墓碑行 | `position=MAX(活跃行)+1`；墓碑行不参与 MAX；读取顺序确定 |
| B17b | 重加墓碑行时清单已有其它行 | 复活行 position 在末尾；读取顺序确定；不覆盖其它行 |
| B18 | reorder 只提交可见行（有 1 个回收站 item） | 可见行按数组顺序；隐藏行追加在后且相对顺序不变；200 |
| B19 | reorder 提交全量（含回收站 item） | 按数组顺序写 position；200 |
| B20 | reorder 少一行/多一行/含墓碑行 | 400 INVALID_INPUT；position 不变 |
| B20b | 清单只有回收站 item（可见集为空），reorder 提交 `[]` | 200 no-op；position 不变；可见集非空时提交 `[]` → 400 |
| B21 | `stateCounts`、`visibleStateCounts` 与 `trashedCount` | `stateCounts` 含回收站 item；`visibleStateCounts` 不含；`trashedCount` 只数 item 在回收站；三者不混 |
| B21b | 清单 5 行，其中 2 行 item 在回收站 | `stateCounts` 合计 5；`visibleStateCounts` 合计 3；`trashedCount=2`；UI 文案注明“含回收站条目” |
| B23 | `includeTrashedItems=1` | 只影响 item 在回收站的行；`loadout_items.deleted_at` 墓碑行仍不返回 |
| B22 | PATCH 清单 `name` 带旧 `expectedVersion` | 409；成员增删不改变 `loadouts.version` |

## 11. 兼容性与冻结面

- 不改 `packages/core/src/contracts.ts`：不新增 `JobKind`/`JobState`/`AppErrorCode`；清单 CRUD 不是 job。
- 不改 `collections` 语义；不改 `project_imports`/`project_refs`/`import_runs` 的写入路径。
- 不改 `docs/api.md` 既有响应形状；新增端点是 additive。
- **冻结面要动**：新表要写进 `apps/server/src/db/schema.sql`，`migrate.ts` 要 bump `SCHEMA_VERSION`；这两个文件是 `docs/CONTRACT.md:5-8` 冻结的。本设计不声称“不用动冻结面”，只声称“既有表/既有 API 形状保持原样，新增是 additive，需批准后由迁移 owner 落地”。
- `mergeItems` 增加 `loadout_items` 迁移（需批准）；资产与 `asset_version_links` 的迁移复用 import spec §9.1 的共享事务；不改其既有图片/标签/分类/软删语义。link-booth 仍不迁 `loadout_items`。
- 无新依赖。

## 12. 已裁定与待用户审阅的语义选择

### 12.1 已裁定（用户 m00689 已批准，不再问）

| # | 选择 | 结论 |
|---|---|---|
| D1 | 清单粒度 | **item 级**（已批准） |
| D2 | 状态枚举 | **`planned/imported/verified`**（已批准） |
| D3 | 合并冲突 | **target 赢**（已批准） |
| D4 | 回收站 item 默认 | 隐藏 + 计数（技术默认） |
| D5 | 是否允许从证据一键改状态 | 否（只读，技术默认） |

### 12.2 仍待用户审阅

无。本子设计没有剩余产品取舍；实现细节（墓碑、reorder 形状、counts 拆分）按本文默认执行。

## 13. 明确不做

- 不做单元级清单（v1）。
- 不做自动从 `item_avatars` 填充。
- 不做自动同步 Unity 状态。
- 不做云同步、AI 推荐、后台扫描引擎。
- 不删除素材、不移动文件。
- 不引入清单历史表/事件溯源（ABA 用墓碑 + 单调 version 解决）。

## 14. 事实与建议索引

- 事实：§2 表；§3 命名对照引用的 `file:line`。
- 建议：§5 DDL、§6 端点、§7 UI、§10 验收；均未执行。
