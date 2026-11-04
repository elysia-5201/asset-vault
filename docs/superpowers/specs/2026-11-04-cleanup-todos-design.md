# 整理待办设计（Feature 3，local 来源口径待用户选择）

- 日期：2026-11-04（revision-4）
- 状态：用户书面设计已批准（m00868，2026-11-04）；待实施计划确认；未开始实施。`localSourcePolicy` 已由用户选定：主 UI 默认选中 `include_local`；**API 仍必填、无服务端默认**，缺参 400 不变
- 范围：四类整理待办（缺封面 / 缺来源 / 未关联模型 / 文件失联）、保存筛选、按 `(item, rule)` 忽略与恢复、默认排除归档与回收站
- 读者：用户、lead、实现者、验证者
- 关联：总览 `2026-11-04-feature123-design.md`；盘点证据 `/root/Code/.asset-vault-feature123-20261104/discovery/workflow/report.md`
- 实施计划：[`../plans/2026-11-04-cleanup-todos-implementation.md`](../plans/2026-11-04-cleanup-todos-implementation.md)
- 修订：revision-1 修 P2-6（陈旧忽略不可见）、P2-7（local 条目全进缺来源）、P3-1（TRIM 不剥制表符）、P3-2（item/asset 关联口径）；revision-2 修 P3 局部（missing_cover 与真实卡片可见一致、ignored=only 的 total/counts 口径）；revision-3 修 review-r2 的 P2-3（`GET /api/cleanup/ignores` 必填 `localSourcePolicy`，resolved 的 local 分支同口径）与错误子码 details.code。四类规则与默认范围已由用户 m00689 批准，不再重开。revision-4 按 review-r3 的 P3-5 补 todos/saved-filter 缺参最小参数形状负例（C27b/C27c），明确是设计级参数形状检查、不是产品端点验收。

> 本文只写设计，不改产品代码、不改 `packages/core/src/contracts.ts`、`apps/server/src/db/schema.sql`、`apps/server/src/db/migrate.ts`、`docs/api.md`。文中的 DDL/端点/字段都是**建议**，实施前需书面 spec 与 plan 分别批准。

## 1. 目标与不变量

### 1.1 目标

给用户一个“整理库”的工作列表：

- 四类待办：`missing_cover`（缺封面）、`missing_source`（缺来源）、`unlinked_model`（未关联模型）、`missing_file`（文件失联）；
- 待办是**派生视图**，不落待办行；只落“忽略”；
- 默认排除 `archived` 与 `trashed`；
- 支持保存筛选（持久化、结构验证、参数化 SQL）；
- 忽略粒度是 `(item, rule)`，可恢复；忽略**不修改素材字段**。

### 1.2 硬不变量

- **待办不落表**：每次查询按规则实时派生，避免规则变化后的陈旧行。
- **默认范围固定**：`items.status NOT IN ('archived','trashed')`；保存筛选**不能**偷偷扩大这个范围。
- **忽略只写 `cleanup_ignores`**：不改 `items`/`assets`/`item_images`/`item_avatars` 的任何字段。
- **四类规则口径固定**（见 §3），不把 `source_gone` 折进 `missing_source`，不把 `exclude` 当“已关联”，不把“有图但没设封面”当缺封面，不把 `missing_file` 说成实时磁盘探测。
- **保存筛选不可拼 SQL**：`filter_json` 先结构验证，再映射为参数化 SQL；用户输入永远走参数。
- **GET 纯读**：所有 GET 端点不写库、不建 job、不写缓存。
- **忽略可被看见**：忽略行必须能独立列出并求当前是否仍命中（`resolved`），否则用户无法发现陈旧忽略。

## 2. 现状事实（只读核对）

| 事实 | 证据 |
|---|---|
| `items.status` ∈ inbox/active/archived/trashed | `packages/core/src/contracts.ts:9`；`apps/server/src/db/schema.sql:46` |
| `items.source_site` 默认 `'local'` | `apps/server/src/db/schema.sql:35` |
| 卡片实际可见图 = `cover_image_id ?? first_image_id` | `apps/server/src/db/repo.ts:221-222` |
| `items.cover_image_id` 外键 `ON DELETE RESTRICT` | `apps/server/src/db/schema.sql:48` |
| `items.source_url` 与 `source_gone` 是两个字段 | `apps/server/src/db/schema.sql:37`、`:51` |
| `item_avatars.match` ∈ any/all/exclude | `apps/server/src/db/schema.sql:168-177`；`contracts.ts:146` |
| `asset_avatars` 是条目内 asset 级证据，无 `match` 列 | `apps/server/src/db/schema.sql:179-187` |
| `assets.status` ∈ present/missing/trashed | `apps/server/src/db/schema.sql:93`；`contracts.ts:14` |
| 重新出现时 `upsertAsset` 把 status 置回 `present` | `apps/server/src/db/repo.ts:411` |
| 现有统计只有 `missing`/`missingFiles`，没有四类待办 | `apps/server/src/db/repo.ts:2422-2434`、`:1312-1347` |
| 现有筛选解析器 `parseItemQuery` 与 `buildWhere` 是参数化 SQL | `apps/server/src/http/routes.ts:101-118`；`apps/server/src/db/repo.ts:153-214` |
| 现有“忽略”只有分类建议 dismiss，不是待办忽略 | `docs/api.md:224` |
| 没有 saved_views 表/端点 | 全库检索无 `saved_views` |
| 状态中文标签：inbox=待整理 | `apps/web/src/ui-state.ts:30` |
| “更多工具”菜单入口 | `apps/web/src/App.tsx:416-424` |
| 当前 `SCHEMA_VERSION = 9` | `apps/server/src/db/migrate.ts:11` |

## 3. 四类规则口径

基础范围（所有规则共用）：`i.status NOT IN ('archived','trashed')`。

### 3.1 `missing_cover`（缺封面）

**判定**：条目**没有可显示的图**，即卡片既没有可解析的 `cover_image_id`，也没有自己的图片行。

```sql
NOT EXISTS (SELECT 1 FROM item_images im WHERE im.id = i.cover_image_id)
AND NOT EXISTS (SELECT 1 FROM item_images im2 WHERE im2.item_id = i.id)
```

- 卡片可见图 = `cover_image_id ?? first_image_id`（`repo.ts:221-222`）。因此“可见”有两种来源：`cover_image_id` 解析到一行图（**不论该图属于哪个 item**），或本 item 有自己的 `item_images` 行。
- 不是 `cover_image_id IS NULL`：卡片在 `cover_image_id` 为空时用第一张图兜底，所以“有图但没设封面”**不算**缺封面。
- 正例：0 张图、`cover_image_id IS NULL` → 待办。
- 反例：1 张图、`cover_image_id IS NULL` → 不是待办（卡片显示第一张）。
- 反例：`cover_image_id` 指向**另一个 item** 的图 → 不是待办（卡片实际显示该图；不改产品填图逻辑）。
- 正例：`cover_image_id` 非空但**悬空**（没有对应 `item_images` 行）→ 待办（卡片没有可解析的图；FK RESTRICT 正常路径下不应出现，但规则按真实可见性判定）。
- 边界：图片行存在但文件缺失/缩略图损坏属于媒体缓存或文件失联问题，不在本规则内；本规则只看“有没有可解析的图行”。

### 3.2 `missing_source`（缺来源）

**判定**：条目没有来源链接，且不是“来源已消失”，且按 local 策略未被排除。

```sql
(i.source_url IS NULL
 OR TRIM(i.source_url, ' ' || char(9) || char(10) || char(13)) = '')
AND i.source_gone = 0
AND (:localPolicy = 'include_local' OR i.source_site <> 'local')
```

- **空白判定（P3-1）**：SQLite 的 `TRIM(X)` 只去空格；制表符/换行/回车要用 `TRIM(X, charlist)`。反例：`source_url = char(9)` 在旧写法下不被判为缺来源；新写法命中。
- `source_gone=1` 表示“曾经有来源、现在源页不在了”，是另一类问题，**不折进** `missing_source`。
- 正例：`source_site='booth'`、`source_url IS NULL`、`source_gone=0` → 待办。
- 反例：`source_url` 非空、`source_gone=1` → 不是 `missing_source`（未来可另设规则，v1 不做）。
- 反例：`source_url` 非空、`source_gone=0` → 不是待办。

#### 3.2.1 local 来源策略（唯一新增口径，需用户显式选择）

`items.source_site` 默认 `'local'`（`schema.sql:35`），扫库建出来的本地条目全部是 `local`。如果一律算缺来源，本地自制素材会把列表淹没；如果一律排除，又可能漏掉“其实是 BOOTH 素材、只是没识别出商品号”的条目。

因此本设计把策略做成**显式参数**，不藏在默认里；**用户已选 `include_local`（m00868），但 API 仍不设服务端默认**：

| 取值 | 语义 | 状态 |
|---|---|---|
| `exclude_local` | `source_site='local'` 的条目不进 `missing_source` | 备选（作者原建议；用户未选） |
| `include_local` | 所有条目按同一口径判定（现状行为） | **用户已选（m00868）：主 UI 默认选中并显式传参**；API 仍必填无默认 |

- **无服务端默认**：`GET /api/cleanup/todos`、`GET /api/cleanup/ignores` 与保存筛选必须显式带 `localSourcePolicy`；缺失 → 400 `INVALID_INPUT`（`LOCAL_POLICY_REQUIRED`）。用户选择前，服务端不静默选任何一边。
- 响应里始终返回 `counts.missing_source.localExcluded`：被策略排除的 local 条目数。用户能看到“有多少条被排除”，可随时切到 `include_local` 复核。
- **已知不足（必须写清）**：库里没有字段区分“用户自制的本地素材”和“未识别出商品号的 BOOTH 素材”。`exclude_local` 会把后者一起排除；`localExcluded` 计数是唯一的补偿信号。要彻底区分需要新增字段（冻结表变更），本轮不做。
- 保存筛选必须保存 `localSourcePolicy`；没有默认值。

### 3.3 `unlinked_model`（未关联模型）

**判定**：没有任何**条目级正向**模型关联。

```sql
NOT EXISTS (
  SELECT 1 FROM item_avatars ia
  WHERE ia.item_id = i.id AND ia.match <> 'exclude'
)
```

- **口径明说（P3-2）**：只看 `item_avatars`（条目级、带 `match` 的关联表）。`asset_avatars`（`schema.sql:179-187`，asset 级、无 `match`）**不算**正向证据；它是条目详情里的辅助证据，不是用户确认的关联。
- `any`/`all` 都算已关联；`exclude` 是“明确不适配”，**不算**已关联。
- 正例：只有 `exclude` 行 → 待办。
- 反例：有 `any` 行 → 不是待办。
- 反例：有 `all` 行 → 不是待办（`all` 是“全部模型都适配”的强关联，不能漏）。
- 反例：有 `any` + `exclude` → 不是待办。
- 正例：0 行 → 待办。
- **已知不足**：只有 `asset_avatars` 行、没有 `item_avatars` 行的条目仍会被判“未关联”。这是有意的（asset 级证据是自动派生，不等于用户确认）；UI 在待办行里显示“有 N 条 asset 级模型证据，未确认”，给用户一键去确认的入口，但不自动改判定。

### 3.4 `missing_file`（文件失联）

**判定**：条目下存在 `assets.status='missing'` 的资产。

```sql
EXISTS (SELECT 1 FROM assets a WHERE a.item_id = i.id AND a.status = 'missing')
```

- **只读既有 status 证据**，不 stat 磁盘、不做实时探测。
- 重新扫描把 status 置回 `present` 后，待办自动消失（无需手动清）。
- UI 文案：“库内标记为缺失（来自上次扫描/确认），不是实时磁盘检查”。

## 4. 方案与取舍

### 4.1 候选方案

- **A（选用）派生待办 + 只落忽略 + 保存筛选表**：规则实时算，忽略/筛选落库；无陈旧待办行。
- **B 物化待办表**：每次扫描写待办行；规则变化/资产变化要同步，容易陈旧；不选。
- **C 纯前端派生**：零后端，但无法跨设备、无法保存忽略/筛选、无法分页；不选。

### 4.2 选择理由

- A 的查询是参数化 SQL + 索引；四类规则都能用现有索引（`ix_items_status`、`ix_assets_item`、`ix_item_avatars_avatar`、`ix_images_item`）。
- A 只新增两张小表；不触碰 `items`/`assets` 的写入路径。
- A 的“忽略”是唯一持久化的用户决策，语义清晰、可恢复。

## 5. 数据模型（建议，未执行）

### 5.1 `cleanup_ignores`

```sql
CREATE TABLE IF NOT EXISTS cleanup_ignores (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  rule TEXT NOT NULL CHECK (rule IN ('missing_cover','missing_source','unlinked_model','missing_file')),
  note TEXT,
  ignored_at TEXT NOT NULL,
  PRIMARY KEY (item_id, rule)
);
CREATE INDEX IF NOT EXISTS ix_cleanup_ignores_rule ON cleanup_ignores(rule, ignored_at);
```

- 主键 `(item_id, rule)`：忽略“缺封面”不影响同条目的“文件失联”。
- 删除行即恢复；不设 `deleted_at`（恢复就是删行）。
- `note` 可选，最长 500 字符（服务端校验）。
- **`resolved` 不落库**：它是查询时按当前规则求出来的派生值（§6.2），避免规则变化后的陈旧标记。

### 5.2 `cleanup_saved_filters`

```sql
CREATE TABLE IF NOT EXISTS cleanup_saved_filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  filter_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- `filter_json` 是**结构化、验证过**的 JSON；不是任意 SQL/表达式。
- `name` 唯一；`version` 用于乐观并发。

### 5.3 迁移与回退

- **单一 owner**：`SCHEMA_VERSION` 9 → 10 只 bump 一次；三份 spec 的表由同一个迁移 owner 一次性落地（见总览 §4）。本 spec 不拥有 `migrate.ts`。
- 幂等：`CREATE TABLE IF NOT EXISTS`；不改既有表、不加列。
- **备份**：迁移前停服务，复制 `vault.db`、`vault.db-wal`、`vault.db-shm`。
- **回退**：停服务 → 恢复三件备份 → 启动旧二进制。**不声称无损 downgrade**：旧代码会忽略多出的表，但会把 `schema_meta.version` 写回 9；只能靠恢复备份。
- 迁移验收：v9 fixture → 迁移 → 表/索引存在、`schema_meta.version=10`、既有行数不变；再跑一次 no-op。

## 6. API 设计（建议，未执行）

### 6.1 待办列表

`GET /api/cleanup/todos?rule=&ignored=hide|show|only&q=&avatar=&category=&sort=updated|title&localSourcePolicy=exclude_local|include_local&limit=&offset=`

- 纯读。
- `rule` 可选；不传 = 四类都算。
- `ignored` 默认 `hide`：隐藏已忽略；`show`：都显示并标 `ignored`；`only`：只看已忽略（**包含已解决/陈旧的忽略行**，见 §6.2）。
- `q`：标题/店铺/作者/备注/标签的子串（与 `buildWhere` 同口径，参数化）。
- `avatar`：逗号分隔 avatar id，默认 any（命中任一）；`category`：逗号分隔分类 id，默认 any；v1 不提供 all 变体。
- `localSourcePolicy`：**必填**，`exclude_local|include_local`；无服务端默认（§3.2.1）。缺失 → 400 `INVALID_INPUT`（`LOCAL_POLICY_REQUIRED`）。
- `sort`：`updated`（默认，`i.updated_at DESC, i.id DESC`）或 `title`（`i.title COLLATE NOCASE ASC, i.id ASC`）。
- `limit` 默认 50、上限 200；`offset` ≥0。
- 响应：

```json
{
  "total": 12,
  "counts": {
    "missing_cover": { "total": 3, "ignored": 1 },
    "missing_source": { "total": 4, "ignored": 0, "localExcluded": 27 },
    "unlinked_model": { "total": 5, "ignored": 2 },
    "missing_file": { "total": 2, "ignored": 0 }
  },
  "items": [
    {
      "item": { "id": 1, "title": "…", "status": "active", "coverUrl": null, "…": "ItemCard" },
      "rule": "missing_cover",
      "ignored": false,
      "resolved": null,
      "evidence": { "imageCount": 0 }
    }
  ]
}
```

- `total` 始终是**当前列表行数**（应用 `rule/q/avatar/category/ignored` 后的行数）；`ignored=only` 时以忽略表为驱动，`total` = 返回的忽略行数（含 `resolved:true`）。
- `counts` 始终是**规则命中计数**（除 `rule` 和 `ignored` 外的筛选生效；`ignored` 不影响 counts），`counts.total` = 四类 rule 命中行数之和；`counts.<rule>.ignored` = 其中已忽略的行数。`ignored=only` 下 `total` 与 `counts.total` 可以不同：UI 分页用 `total`，tab 数字用 `counts`；响应/文案必须注明两者口径不同。
- `counts.missing_source.localExcluded` 只在 `localSourcePolicy=exclude_local` 时非零；它是“被策略排除的 local 条目数”，不是待办数。
- 一个 item 命中多个 rule → 多行（`item, rule`），`total` 是行数。
- `resolved`：普通待办行恒为 `null`；只有 `ignored=only` 的忽略行才求值（`true` = 问题已不存在，`false` = 问题仍在）。
- 错误：`400 INVALID_INPUT`（非法 rule/ignored/sort/limit/localSourcePolicy）；`500` 未预期。

### 6.2 忽略 / 恢复（含 resolved）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/cleanup/ignores?resolved=any|true|false&localSourcePolicy=exclude_local|include_local&limit=&offset=` | 纯读；`localSourcePolicy` **必填**（与 todos/保存筛选同口径；缺失 400 `LOCAL_POLICY_REQUIRED`）；`{total, ignores: [{itemId, rule, note, ignoredAt, resolved, item: {id,title,status}}]}`；limit 默认 50、上限 200；按 `ignored_at DESC, item_id` |
| POST | `/api/cleanup/ignore` | `{itemId, rule, note?}` → 200 `{ignore}`；`note` ≤500；幂等 upsert（已存在则更新 note/ignored_at） |
| DELETE | `/api/cleanup/ignore/:itemId/:rule` | → `{removed: 0|1}`；幂等，不 404 |

- **`resolved` 的定义（P2-6 / P2-3）**：对该忽略行的 `(item, rule)` 单独求值——把 §3 的规则条件套到这一条 item 上（**不套基础范围**，因为 item 可能已归档/回收站；归档/回收站本身不算“问题已解决”，但也不在默认列表里）。`missing_source` 的 local 分支按请求的 `localSourcePolicy` 求值；其余三类规则与 local 策略无关。命中 → `resolved:false`；不命中 → `resolved:true`。
- `GET /api/cleanup/ignores` 独立列出**全部**忽略行，不依赖待办派生结果；因此“问题已解决”的陈旧忽略也能被看到、被恢复。该端点必须带 `localSourcePolicy`；缺失 400 `LOCAL_POLICY_REQUIRED`。
- `ignored=only` 的待办列表：以 `cleanup_ignores` 为驱动表，left join 规则求值，返回 `resolved`；已解决的忽略行也返回（`resolved:true`），UI 标“问题当前不存在”。
- 忽略只写 `cleanup_ignores`；不改 item/assets。
- 恢复 = 删除忽略行；问题仍在则回到列表，问题已解决则自然不出现。

### 6.3 保存筛选

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/cleanup/filters` | 纯读；`{filters: [{id, name, filter, version, createdAt, updatedAt}]}` |
| POST | `/api/cleanup/filters` | `{name, filter}` → 201 `{filter}`；`name` 1..80；同名 409；结构非法 400 |
| PATCH | `/api/cleanup/filters/:id` | `{name?, filter?, expectedVersion}` → `{filter}`；`expectedVersion` 必填；CAS 失败/同名 409 |
| DELETE | `/api/cleanup/filters/:id` | → `{deleted: 0|1}`；幂等，不 404 |

`filter` 的结构（严格校验，未知键拒绝）：

```json
{
  "rule": "missing_cover",
  "q": "shinano",
  "avatarIds": [1, 2],
  "categoryIds": ["clothing.tops"],
  "ignored": "hide",
  "localSourcePolicy": "exclude_local",
  "sort": "updated",
  "limit": 50
}
```

- 除 `localSourcePolicy` 外所有字段可选；`localSourcePolicy` **必填**（`exclude_local|include_local`，无默认；缺失 → 400 `INVALID_INPUT`（`LOCAL_POLICY_REQUIRED`））；`rule` 枚举；`q` 最长 200；`avatarIds` 最多 50 个整数；`categoryIds` 最多 50 个字符串；`ignored` 枚举；`sort` 枚举；`limit` 1..200。
- **没有** `includeArchived`/`includeTrashed` 字段；出现即 400。基础范围固定，保存筛选不能偷偷扩大。
- 服务端把验证后的对象映射为参数化 SQL（复用 `buildWhere` 的思路），**绝不字符串拼接用户输入**。

## 7. UI 设计

### 7.1 入口

- “更多工具”菜单（`App.tsx:416-424`）增加“整理待办”。
- 面板：四个 rule tab + 计数；搜索框；头像/分类筛选；“显示已忽略”开关；保存筛选下拉；local 策略**必选**（“排除本地条目 / 包含本地条目”，主 UI 默认选中 `include_local`；旁边显示被排除数）。“已忽略管理”独立入口同样必选 local 策略，与 todos/保存筛选同口径。

### 7.2 列表与文案

- 每行：条目卡片（复用 `ItemCardView`）+ rule 标签 + 忽略/恢复按钮 + 跳详情。
- rule 文案：`缺封面` / `缺来源` / `未关联模型` / `文件失联`。
- `missing_file` 行必须显示“库内标记为缺失（来自上次扫描/确认），不是实时磁盘检查”。
- 已忽略行（`ignored=only` 或“已忽略管理”独立视图）显示“已忽略（问题当前存在/不存在）”，由 `resolved` 驱动；`ignored=show` 只标记 ignored，不独立求值 `resolved`；`resolved=true` 的行提供“恢复”按钮，让用户清理陈旧忽略。
- “已忽略管理”独立入口：列出全部忽略行，可按 `resolved` 过滤，可恢复。
- 保存筛选：输入名称 → 保存当前条件；下拉应用；改名/删除。

### 7.3 文案纪律

- 不把“待整理”（inbox 状态）与“整理待办”混用；面板标题用“整理待办”。
- 不承诺“自动修复封面/来源/模型/文件”；只提供跳转与忽略。
- local 策略必须显示为“排除本地条目 / 包含本地条目”，并显示被排除数；不得静默排除。主 UI 默认选中 `include_local`（用户 m00868 已准），API 仍必填、无服务端默认。

## 8. 并发、事务、一致性

- 忽略：`INSERT … ON CONFLICT(item_id,rule) DO UPDATE SET note=excluded.note, ignored_at=excluded.ignored_at`；单行幂等，无丢更新问题。
- 恢复：`DELETE`；幂等。
- 保存筛选创建：单条 `INSERT`；唯一冲突 409。
- 保存筛选更新：`UPDATE … WHERE id=? AND version=?` 的 CAS；0 行 → 409。**不声称线程安全**：实际保证是单进程 + better-sqlite3 同步执行 + SQLite WAL + `busy_timeout=5000`；跨进程并发不在保证范围。
- 审计：忽略/恢复/保存筛选的创建/更新/删除写 `audit_log`（`repo.ts:1349`）。

## 9. 生命周期与清理

| 事件 | 影响 |
|---|---|
| item 软删（`status='trashed'`） | 待办默认不出现（基础范围排除）；忽略行保留 |
| item 恢复 | 待办重新按规则出现；忽略仍生效 |
| `mergeItems(source→target)` | 在合并事务内把 `cleanup_ignores` 从 source 迁到 target：`INSERT OR IGNORE` 后删 source；同 rule 冲突保留 target；审计 |
| item 硬删（当前无产品入口） | `ON DELETE CASCADE` 删除忽略行 |
| 规则条件解决 | 待办自然消失；忽略行**不自动删除**（粘性）；`GET /api/cleanup/ignores` 显示 `resolved:true` |
| 规则条件重现 | 若忽略行仍在，默认仍隐藏；`ignored=show|only` 可见，`resolved:false` |

## 10. 验收（可执行的正反例）

| # | 场景 | 期望 |
|---|---|---|
| C1 | 条目 0 张图、`cover_image_id IS NULL` | `missing_cover` 命中 |
| C1b | 条目 0 张自己的图，`cover_image_id` 指向另一个 item 的图 | 不命中（卡片实际显示该图） |
| C1c | 条目 0 张图，`cover_image_id` 悬空（无对应图行） | `missing_cover` 命中（卡片没有可解析的图） |
| C2 | 条目 1 张图、`cover_image_id IS NULL` | 不命中（卡片有可见图） |
| C3 | 条目 `source_url IS NULL`、`source_gone=0`、`source_site='booth'` | `missing_source` 命中 |
| C4 | 条目 `source_url` 非空、`source_gone=1` | 不命中 `missing_source` |
| C5 | 条目只有 `item_avatars.match='exclude'` | `unlinked_model` 命中 |
| C6 | 条目有 `match='any'` | 不命中 |
| C7 | 条目有 `match='all'` | 不命中（`all` 是正向关联） |
| C8 | 条目只有 `asset_avatars` 行、无 `item_avatars` | 仍命中 `unlinked_model`；UI 显示 asset 级证据提示 |
| C9 | 条目有 `assets.status='missing'` | `missing_file` 命中 |
| C10 | 重新扫描把 missing 置回 present | `missing_file` 自动消失，无需手动清 |
| C11 | 忽略 `(item, missing_cover)` | 默认列表隐藏；`counts.missing_cover.ignored+1`；同条目 `missing_file` 不受影响 |
| C12 | 恢复忽略 | 回到列表；`removed=1`；再删一次 `removed=0` |
| C13 | 忽略前后快照 item/assets 行 | 字段完全不变（只写 `cleanup_ignores`） |
| C14 | 默认列表 | 不含 `archived`/`trashed` |
| C15 | 保存筛选含 `includeArchived:true` | 400 INVALID_INPUT；不落库 |
| C16 | 保存筛选 `q="' OR 1=1 --"` | 参数化查询；返回 0 行或正常匹配；无 SQL 错误 |
| C17 | 保存筛选重启后 | 仍在；`version` 递增；CAS 旧版本 409 |
| C18 | 四类计数与列表（`ignored=hide|show`） | `counts` 与对应 rule 的 `total` 一致（除 rule 外同筛选）；`ignored=only` 见 C26 |
| C19 | GET 端点 | 纯读；前后 DB 行数不变 |
| C20 | `source_url = char(9)`（只有制表符） | 新写法命中 `missing_source`；旧 `TRIM()` 写法不命中（反例对照） |
| C21 | `source_site='local'`、`source_url IS NULL`，用户选择 `exclude_local` | 不进 `missing_source`；`localExcluded` 计数 +1 |
| C22 | 同上，用户选择 `include_local` | 进 `missing_source`；`localExcluded=0` |
| C27 | `GET /api/cleanup/todos` 或 `GET /api/cleanup/ignores` 缺 `localSourcePolicy` | 400 `INVALID_INPUT`（`LOCAL_POLICY_REQUIRED`）；不静默选默认 |
| C27b | `GET /api/cleanup/todos` 单独缺 `localSourcePolicy` | 400 `INVALID_INPUT`（`LOCAL_POLICY_REQUIRED`）；不静默选默认；设计级参数形状负例，不是产品端点验收 |
| C27c | `POST/PATCH /api/cleanup/filters` 的 `filter` 缺 `localSourcePolicy` | 400 `INVALID_INPUT`（`LOCAL_POLICY_REQUIRED`）；不落库；设计级参数形状负例，不是产品端点验收 |
| C28 | `exclude_local` 下，local 条目的 `missing_source` 忽略行 | `resolved:true`（问题按该策略不存在）；`ignored=only` 仍返回并标“问题当前不存在” |
| C28b | `include_local` 下，同一 local 条目的 `missing_source` 忽略行 | `resolved:false`（问题仍在）；与 C28 形成正反例 |
| C28c | `missing_cover`/`unlinked_model`/`missing_file` 忽略行 | `resolved` 与 `localSourcePolicy` 无关；两种取值结果相同 |
| C23 | 忽略 `(item, missing_cover)` 后补图 | `GET /api/cleanup/ignores` 该行 `resolved:true`；`ignored=only` 仍返回该行并标“问题当前不存在”；可恢复 |
| C24 | 忽略 `(item, missing_file)` 后文件仍缺失 | `resolved:false`；`ignored=only` 返回并标“问题当前存在” |
| C25 | 合并 source→target，两边同 rule 都有忽略 | 保留 target 行；source 行删除；审计有记录 |
| C26 | `ignored=only`，2 条忽略（1 条 resolved、1 条未解决），规则命中 3 行 | 顶层 `total=2`（当前列表行数）；`counts.total=3`（规则命中）；`counts.<rule>.ignored=1`；文案注明两者口径不同 |

## 11. 兼容性与冻结面

- 不改 `packages/core/src/contracts.ts` 的外层枚举：不新增 `JobKind`/`JobState`/`AppErrorCode`；待办查询不是 job。子码（如 `LOCAL_POLICY_REQUIRED`）放 additive 可选 `details.code`，不新增外层 enum；若需给 `AppError` 加可选 `details` 字段，属 `contracts.ts` 的 additive 变更，列入限定冻结面，需批准。
- 不改 `items`/`assets`/`item_images`/`item_avatars` 的写入路径；忽略只写新表。
- 不改 `docs/api.md` 既有响应形状；新增端点是 additive。
- **冻结面要动**：新表要写进 `apps/server/src/db/schema.sql`，`migrate.ts` 要 bump `SCHEMA_VERSION`；这两个文件是 `docs/CONTRACT.md:5-8` 冻结的。本设计不声称“不用动冻结面”，只声称“既有表/既有 API 形状保持原样，新增是 additive，需批准后由迁移 owner 落地”。
- `mergeItems` 增加 `cleanup_ignores` 迁移（需批准）；不改其既有语义。
- 无新依赖。

## 12. 已裁定与待用户审阅的语义选择

### 12.1 已裁定（用户 m00689 已批准，不再问）

| # | 选择 | 结论 |
|---|---|---|
| D1 | 问题解决后忽略是否自动过期 | 否（粘性，直到手动恢复） |
| D2 | `missing_source` 是否包含 `source_gone=1` | 否（分开） |
| D3 | `unlinked_model` 是否把 `exclude` 当已关联 | 否（只算 any/all） |
| D4 | 保存筛选是否允许包含归档/回收站 | 否（字段不存在，出现即 400） |
| D5 | 待办是否包含没有任何资产的条目 | 是（四类规则独立判定） |

### 12.2 已裁定（m00868）

| # | 选择 | 状态/默认 | 备选 | 影响 |
|---|---|---|---|---|
| D6 | local 条目是否算“缺来源” | **用户已选 `include_local`（m00868）**：主 UI 默认选中并显式传参；API 仍必填、无服务端默认 | `exclude_local` 仍为合法取值 | 两种语义/计数/验收对等；`localExcluded` 是补偿信号 |

## 13. 明确不做

- 不做物化待办表、不做后台扫描引擎。
- 不做自动修封面/补来源/关联模型/恢复文件。
- 不做“实时磁盘探测”。
- 不做 AI/云/自动 Unity。
- 不把 `source_gone` 折进 `missing_source`。
- 不把 `exclude` 当已关联。
- 不新增“local 判定”字段（冻结表变更，本轮不做）。

## 14. 事实与建议索引

- 事实：§2 表；§3 规则引用的 `file:line`。
- 建议：§5 DDL、§6 端点、§7 UI、§10 验收；均未执行。
