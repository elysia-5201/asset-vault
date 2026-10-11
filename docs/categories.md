# 物品分类（Asset Categories）设计与接口契约（冻结）

> 本文件是「物品分类」功能的**接口契约**，服务端 / 前端 / 测试都按它实现。
> 冻结点：DB v2 + packages/core/src/categories/** 已实现并 tsc 干净。改动契约前先找 lead。

## 0. 两个"分类"不是一个东西（重要）

| 名称 | 列 / 表 | 含义 | UI 文案 |
|---|---|---|---|
| BOOTH 来源分类 | `items.category_name` / `category_parent` | 商品页自带的分类（如「3Dモデル>衣装」），只读、用于展示 | 「BOOTH 分类」（只读） |
| **物品分类**（本次新增） | `items.cat_id` / `cat_sub_id` + 13 个 `cat_*` 列 | 用户自己的分类体系，可手改、可自动推荐 | 「分类」 |

**禁止**把新分类写进 `category_name`，也禁止让新逻辑读它当作归属（它只作为分类证据的一种）。

## 1. 数据模型（DB v2）

```sql
CREATE TABLE categories (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  parent_id TEXT REFERENCES categories(id) ON DELETE RESTRICT,
  sort INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- items 追加列：
--   cat_id TEXT, cat_sub_id TEXT, cat_source TEXT, cat_confidence REAL,
--   cat_reason TEXT, cat_evidence TEXT, cat_assigned_at TEXT,
--   cat_suggest_id TEXT, cat_suggest_sub_id TEXT, cat_suggest_confidence REAL,
--   cat_suggest_reason TEXT, cat_suggest_evidence TEXT, cat_suggest_at TEXT
```

- 结构固定**两层**：`parent_id IS NULL` = 主分类；子分类的 `parent_id` 指向主分类。ID 形如 `clothing` / `clothing.tops`（**发布后不得改 ID**）。
- `cat_id IS NULL` = 未分类。分类树里的 `other.uncategorized`（名为「未分类」）是**人工显式选择**的一个分类，二者在 UI 上要区分（前者显示灰 chip「未分类」，后者显示「其他 › 未分类」）。
- 迁移：`apps/server/src/db/migrate.ts` 先 `ALTER TABLE` 补列（`PRAGMA table_info` 守卫）→ 再跑 `schema.sql`（新列索引）→ 再播种分类树（`ON CONFLICT(id) DO NOTHING`，**不覆盖**用户改名/排序/停用）。两版本：SCHEMA_VERSION = 2。
- 历史数据：迁移后所有老条目 `cat_id IS NULL` = 未分类（符合需求「历史素材统一显示为未分类，随后允许批量分类」）。

## 2. 分类定义与规则（唯一真源）

- `packages/core/src/categories/taxonomy.ts`：DEFAULT_TAXONOMY（14 主分类 / 79 子分类 = 93 个）、`validateTaxonomy()`、`topCategories()`/`childrenOf()`/`categoryById()`/`categoryPath()`/`isAncestor()`、类型 `CategoryDef`/`CategorySource`/`CategoryLevel`。
- `packages/core/src/categories/classify.ts`：`recommendCategory(input, thresholds?, defs?, rules?)` → `CategoryRecommendation`、`CATEGORY_RULES`、`FIELD_WEIGHT`/`FIELD_LABEL`、`evidenceToJson()`、`DEFAULT_CATEGORY_THRESHOLDS = { autoThreshold: 0.75, suggestThreshold: 0.4 }`。
- 分级语义：`confidence >= autoThreshold` → `level="auto"`（高置信度，允许自动应用，必须可追溯）；`>= suggestThreshold` → `"suggest"`（只给建议）；否则 `"none"`（保持未分类，**不得**为凑自动分类率硬塞）。
- 置信度 = `min(1, score / 2.0)`，与第二分类差距 < 35% 时 ×0.6（歧义降权）。**未校准，不得当真实概率**；阈值可配置（settings 键 `category_auto_threshold` / `category_suggest_threshold`）。
- 证据字段与权重：title 1.0 / filename 0.9 / booth_category 0.9 / tag 0.8 / unitypackage_path 0.7 / archive_path 0.6 / description 0.5 / notes 0.4 / shop 0.3。
- 否定语境：命中词前后 6 字符窗口内出现 `なし/無し/no …` → 该条证据作废；同一规则同一字段内**长词优先**（`シェーダー` 命中后不再计 `シェーダ`）。

## 3. Repo 可用方法（apps/server/src/db/repo.ts，已实现）

```ts
categoryDefs(force?: boolean): CategoryDef[]              // 进程内缓存
invalidateCategories(): void
listCategories(): CategoryNode[]                          // 树 + itemCount
createCategory({id?, name, parentId?, sort?}): CategoryNode
updateCategory(id, {name?, parentId?, sort?, enabled?}): CategoryNode
deleteCategory(id): { moved: number; movedSubs: number }   // 有子分类 → 409
categoryStats(): { counts: {id,name,parentId,count,topCount,owned,favorite}[]; uncategorized; pending; total; missingFiles }
listItemTagNames(itemId): string[]
setItemCategory(itemId, { categoryId, subCategoryId?, source, confidence?, reason?, evidence? }): ItemRow
    // 用户路径：无条件写；子分类不属于主分类 → 自动清空；同时清掉建议；写 audit_log
suggestItemCategory(itemId, { categoryId, subCategoryId?, confidence, reason?, evidence? }): void
clearItemCategorySuggestion(itemId): void
applyAutoCategory(itemId, rec): { applied: boolean; protected: boolean }
    // 自动路径：若当前是 manual/confirmed → 只写建议（protected=true），绝不覆盖
logAudit(action, entity, entityId, before, after): void
```
ItemQuery 追加：`categoryIds?: string[]`、`categoryMatch?: "any"|"all"`、`uncategorized?: boolean`、`pendingCategory?: boolean`。
ItemCard 现在带 `category?: CategoryAssignment | null` 与 `suggestion?: CategorySuggestion | null`。

## 4. HTTP 接口（服务端实现）

```
GET    /api/categories
       200 { categories: CategoryNode[]  /*树，含 itemCount*/, stats: CategoryStats, config: { autoThreshold, suggestThreshold } }
POST   /api/categories            body {id?, name, parentId?, sort?}             -> 201 { category }
PATCH  /api/categories/:id        body {name?, sort?, enabled?, parentId?}       -> 200 { category }
DELETE /api/categories/:id                                                       -> 200 { moved, movedSubs }
PUT    /api/categories/config     body {autoThreshold?, suggestThreshold?}       -> 200 { autoThreshold, suggestThreshold }

GET    /api/items?...&catIds=clothing,clothing.tops&catMatch=any&uncategorized=1&pendingCategory=1
       catMatch=any（默认）：命中任一选中节点；catMatch=all：条目分类路径必须包含每个选中节点
       uncategorized=1 -> cat_id IS NULL；pendingCategory=1 -> 有未确认建议

POST   /api/items/:id/category            body { categoryId: string|null, subCategoryId?: string|null }
       -> 200 { item: ItemDetail }      // categoryId=null 清除归属；source='manual'
POST   /api/items/:id/category/accept     -> 200 { item }   // 采纳当前建议：source='confirmed'，清建议
POST   /api/items/:id/category/dismiss    -> 200 { item }   // 忽略建议：只清建议，不动归属
POST   /api/items/category/batch          body { itemIds: number[], categoryId?: string|null,
                                                 subCategoryId?: string|null,
                                                 mode?: "set"|"clear_sub"|"resuggest" }
       -> 200 { updated: number, failed: { itemId: number, reason: string }[], requested: number }
POST   /api/categories/reclassify         body { itemIds?: number[], onlyUncategorized?: boolean,
                                                 apply?: boolean, all?: boolean, limit?: number }
       -> 200 { scanned, applied, suggested, cleared, skipped, protected,
                results: { itemId, categoryId, subCategoryId, confidence, level, applied, protected, reason }[] }
```

错误统一走既有 `fail(reply, e)`：`{ error: { code, message } }`，非法输入 400 / 不存在 404 / 冲突 409。

## 5. 自动分类钩子（服务端）

`apps/server/src/services/categories.ts`（新文件）：

```ts
export interface CategoryServiceOptions { auto?: boolean; log?: (m: string) => void }
collectEvidence(repo: Repo, itemId: number): CategoryEvidenceInput   // 标题/描述/标签/BOOTH分类/文件名/包内路径/unitypackage 路径
getCategoryConfig(repo): { autoThreshold: number; suggestThreshold: number }   // 读 settings，坏值回落默认
setCategoryConfig(repo, patch): { autoThreshold: number; suggestThreshold: number }
recommendForItem(repo, itemId, opts?): CategoryRecommendation
applyCategoryEvidence(repo, itemId, opts?): { ok: boolean; applied: boolean; protected: boolean; level: CategoryLevel; categoryId: string|null; error?: string }
    // 永不抛：内部 try/catch，失败只 log —— 分类异常不得阻断主流程
reclassifyCategories(repo, opts): 上面 /api/categories/reclassify 的结果
```

调用点（全部 **try/catch 包住**，失败不影响主流程）：
1. 扫库建档（`services/scan.ts`）与 `POST /api/import/paths` 建档后；
2. BOOTH 链接导入 / 补全元数据（`services/booth.ts`、`POST /api/items/:id/link-booth`）后；
3. Inbox 入库（`services/watcher.ts` → 作业）与 `jobs/runner.ts` 在 indexing/matching 完成后；
4. `PATCH /api/items/:id` 且 body 含 `title/title_ja/description/category_name/category_parent/shop_name/author` 时（纯 UI 开关如 favorite/status 不触发）。

## 6. 人工分类优先（强制，需求 §6）

- `cat_source` ∈ `manual`（下拉框手选）/`confirmed`（采纳建议）/ `auto`（自动应用）/`migrated`（历史迁移）。
- **manual / confirmed 永不被自动任务覆盖**：唯一入口是 `repo.applyAutoCategory()`（已实现保护），自动路径**不得**直接调用 `setItemCategory()`。
- 重扫压缩包、Inbox 重试、后台任务恢复、补全商品信息、更新商品信息：一律走 `applyAutoCategory`。
- 合并（`repo.mergeItems`）已实现：目标未分类→继承；一用户一自动→用户赢；两边用户已定且不同→保留目标 + `categoryConflicts` 返回 + audit_log（不静默覆盖）。拆分/套装增删不触碰分类。

## 7. 前端要求（需求 §4）

- 卡片：分类徽章（主分类优先，子分类可作「主 › 子」），未分类显示灰 chip「未分类」，有待确认建议时加一个可点提示；不遮挡缩略图/标题。
- 详情页：主分类下拉 → 子分类联动下拉（切主分类必须清空不再属于它的子分类）→ 保存 → 立即刷新；显示来源标签（手动设置/采纳建议/自动推断/历史迁移，自动的要有依据+置信度，可折叠展开证据）；建议卡片带「采纳」「忽略」。
- 筛选：分类多选（树状，显示计数）、只看未分类、只看待确认、清除分类筛选；必须作用于**真实查询**（拼进 /api/items 参数），可与关键词/Avatar/标签/收藏/拥有状态组合。
- 批量：选择模式（复选框，**不要**复用整卡点击）+ 批量设置主分类/子分类/批量移除子分类/批量重新生成建议/仅对未分类批量；执行前显示将影响的条数，失败要逐条反馈。
- 沿用现有 UI 风格与 CSS 令牌；分类下拉/筛选要跳过 `enabled=false`（但已归属的条目仍要显示其分类名）。

## 8. 验收（需求 §9）

1. 迁移成功且旧数据完整（老条目 = 未分类）；2. 分类/子分类关系合法（两层、父存在）；3. 手动分类不被自动任务覆盖；
4. 自动分类能解释依据；5. 未知类型保持未分类；6. 分类筛选与现有筛选组合；7. 分类计数与真实查询一致；
8. Inbox 自动入库不受影响；9. 套装/合并/回收站恢复正常；10. 搜索/预览/unitypackage 解析/Unity 导入正常；
11. 自动分类异常不阻断主流程；12. 单元测试 + 迁移测试 + 集成测试。

## 9. 写权限边界（避免互相踩）

| 范围 | 归属 |
|---|---|
| `packages/core/src/categories/**`、`apps/server/src/db/**`、本文件 | lead（只读） |
| `apps/server/src/services/**`、`apps/server/src/http/routes.ts`、`docs/api.md` | 服务端子代理 |
| `apps/web/**` | 前端子代理 |
| `test/**`、`packages/core/test/**`、`apps/server/test/**` | 测试子代理 |
| `README.md`、`apps/desktop/build/**` | lead |
