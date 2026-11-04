# Feature 1-2-3 总览：导入预检、按模型搭配清单、整理待办

- 日期：2026-11-04（revision-4）
- 状态：三份书面设计已获用户书面批准（m00868，2026-11-04）；待实施计划确认；未开始实施
- 读者：用户、lead、实现者、验证者
- 子设计：
  - [导入前预检与版本关系](./2026-11-04-import-precheck-design.md)
  - [按模型搭配清单](./2026-11-04-avatar-loadouts-design.md)
  - [整理待办](./2026-11-04-cleanup-todos-design.md)
- 实施计划：[`../plans/2026-11-04-feature123-implementation.md`](../plans/2026-11-04-feature123-implementation.md)（总入口）
- 修订：revision-1 按独立 review（`design/review/report.md`）修 3 个 P1 + 9 个 P2 + 9 个 P3；revision-2 按 review-r1 定向闭合 N1–N4 与 P3-5/局部 P3，不扩架构；revision-3 按 review-r2 修 P2-1（commit 重验 pathCollision）、P2-2（重放 200 指针 / 同 nonce 异 token 409）、P2-3（ignores 必填 localSourcePolicy）与 10 项 P3 局部澄清，不扩架构。revision-4 按 review-r3 修新 P2（并发同 token 在事务内重查回执）与 7 项 P3 局部澄清，不扩架构。

> 本总览只做导航与共享约束，不重复三份子设计的细节。三份子设计各自完整、可独立审阅；实施前每份都需要书面 spec 批准，之后还需要 plan 批准。

## 1. 一句话目标

在**既有表与既有 API 形状保持原样**、不引入新依赖、不做 AI/云/自动 Unity/后台扫描引擎的前提下，给 AssetVault 增加三件互相独立的能力：

1. **导入前预检**：登记前告诉用户“字节重复 / 同商品 / 版本候选 / 配套候选 / 路径冲突”，用户跳过或继续；版本关系人工确认、可更正、可撤销、持久化；旧文件保留。
2. **按模型搭配清单**：一个模型多份清单，按 item 添加，`(清单, item)` 手动状态独立，与 Unity 登记/引用/校验证据分层。
3. **整理待办**：四类待办（缺封面/缺来源/未关联模型/文件失联）+ 保存筛选 + 按 `(item, rule)` 忽略/恢复；默认排除归档与回收站；不改素材字段。

## 2. 三份子设计的分工

| 子设计 | 解决的问题 | 新表 | 新端点 | 主要 UI |
|---|---|---|---|---|
| [导入预检](./2026-11-04-import-precheck-design.md) | 登记前重复/同商品/版本/配套/路径冲突提示；版本关系持久化 | `asset_version_links`、`import_stage_commits`（技术回执） | `/api/import/precheck`、`/api/items/:id/version-links`、`/api/import/download/commit` | ImportPanel 预检卡；ItemDetail 版本关系区；下载确认卡 |
| [搭配清单](./2026-11-04-avatar-loadouts-design.md) | 按模型维护“准备用哪些素材”；每项手动状态 | `loadouts`、`loadout_items` | `/api/avatars/:id/loadouts`、`/api/loadouts/*` | Avatar 轨“搭配”；ItemDetail“加入搭配清单” |
| [整理待办](./2026-11-04-cleanup-todos-design.md) | 四类整理问题 + 忽略 + 保存筛选 | `cleanup_ignores`、`cleanup_saved_filters` | `/api/cleanup/*` | “更多工具 → 整理待办”面板 |

三份设计在**数据与逻辑上互不依赖**：可以分别审阅、分别批准、分别实施。共享的只有 schema 版本与迁移 owner（§4）。

## 3. 共享约束（三份都适用）

### 3.1 冻结面（准确表述）

- `packages/core/src/contracts.ts`：只读；不新增外层 `JobKind`/`JobState`/`AppErrorCode`。错误子码放 additive 可选 `details.code`；若需给 `AppError` 加可选 `details` 字段，属 additive 变更，列入限定冻结面，需批准。
- `apps/server/src/db/schema.sql` + `apps/server/src/db/migrate.ts`：**是冻结文件，本轮设计要改它们**——新表/索引/触发器写进 `schema.sql`，`SCHEMA_VERSION` 9→10 写进 `migrate.ts`。设计阶段只读；实施必须经书面 spec + plan 批准，由单一迁移 owner 落地。
- `docs/api.md`：只读；新增端点是 additive，不改既有响应形状。
- `docs/CONTRACT.md:5-8` 的冻结声明继续有效。
- **准确说法**：既有表、既有列、既有索引、既有 API 响应形状保持原样；新增是 additive。**不声称“不用动冻结面”**。

### 3.2 不新增的东西

- 不新增 npm 依赖。
- 不新增 job kind、不改 job 状态机。
- 不改 `planHash` 口径、不改 `PreviewChange` 枚举。
- 不做 AI/云/自动 Unity/后台扫描引擎。
- 不自动合并、不自动跳过、不自动改归属。
- 不删除/移动源文件。

### 3.3 只读与证据分层

- 预检只读；待办派生只读；清单证据只读。
- 用户声明（清单状态、版本关系、忽略）与自动证据（登记/引用/校验/哈希）分列，互不静默改写。

## 4. Schema v10：单一 owner，一次 bump

### 4.1 规则

- 当前 `SCHEMA_VERSION = 9`（`apps/server/src/db/migrate.ts:11`）。
- 三份子设计的新表统一进 **v10**，由**一个迁移 owner** 一次性落地；不允许三个子项目各自抢 v10。
- `schema.sql` 按子设计分三节（预检 / 清单 / 待办），每节 `CREATE TABLE IF NOT EXISTS` + 索引/触发器；`migrate.ts` 只 bump `SCHEMA_VERSION` 并记录 `schema_meta.version`；不改既有表、不加列。
- 若某个子设计未获批准，其 DDL 节在迁移冻结前移除；版本号仍为 10，不留给后续子项目再抢。后续新增表走 v11。
- 迁移 owner 建议为 lead（或 lead 指定的单一实现者）；三份子设计的实现者不直接改 `migrate.ts`。
- **触发器演进**：`CREATE TRIGGER IF NOT EXISTS` 不会更新已存在的同名触发器；以后改定义必须 `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`。

### 4.2 幂等、备份、回退

- 幂等：重复执行 no-op；v9 库创建新表，v10 库不变。
- 备份：迁移前停服务，复制 `vault.db`、`vault.db-wal`、`vault.db-shm`。
- 回退：停服务 → 恢复三件备份 → 启动旧二进制。**不声称无损 downgrade**：旧代码会忽略多出的表，但会把 `schema_meta.version` 写回 9；只能靠恢复备份。
- 迁移验收：v9 fixture → 迁移 → 表/索引/触发器存在、`schema_meta.version=10`、既有行数不变；再跑一次 no-op。

### 4.3 表清单

| 子设计 | 表 | 关键约束 |
|---|---|---|
| 预检 | `asset_version_links` | `UNIQUE(asset_a_id, asset_b_id)`（全局）、`CHECK(asset_a_id < asset_b_id)`、同 item 触发器、`state`/`relation` CHECK |
| 预检 | `import_stage_commits` | `nonce` 主键、`token_hash`、`decision` CHECK、`item_id/asset_id` 可空（`ON DELETE SET NULL`；指针失联重放 410）；技术回执，不是产品子系统 |
| 清单 | `loadouts` | `UNIQUE(avatar_id, name)`、FK avatar CASCADE、`version`（只保护 name/note/sort） |
| 清单 | `loadout_items` | `PRIMARY KEY(loadout_id, item_id)`、FK loadout/item CASCADE、`state` CHECK、`version`（单调；source 活跃转墓碑 +1、已墓碑不变）、`deleted_at` 墓碑 |
| 待办 | `cleanup_ignores` | `PRIMARY KEY(item_id, rule)`、FK item CASCADE、`rule` CHECK |
| 待办 | `cleanup_saved_filters` | `UNIQUE(name)`、`filter_json` 结构验证、`version` |

## 5. 规则与取舍（快速审阅）

### 5.1 导入预检

- **精确 sha256 ≠ 同商品 ≠ 版本已证实**：三个独立维度；`exact` 只说明字节相同。
- **exact 的判据**：入参现算 + 候选 `sha256_state='ok'` + 磁盘 stat 与库内 size/mtime 一致 + **候选本次重算 sha256 相等**。`last_verified_at` **不是**哈希新鲜度证明；预算不足 → `existing_hash_unverified`，不称 exact。
- **版本候选只在同商品 + 双方版本键可解析时给**；`proven:false`；文件名/标题不是证明。
- **同商品不同文件不建第二个 item**：复用 `(source_site, source_item_id)` 唯一索引对应的 item，新文件成为新 asset。
- **旧文件保留**：预检/导入/版本确认都不删不覆盖旧 asset。
- **预检只读**：不写库、不建 job、不调用 `computeSignature`/`fingerprintOf`/`findDuplicatesForItem`/`mergeItems`。
- **接受列表即契约**：预检接受后，导入只收“展开后的文件列表 + 每文件 expected”；执行不递归目录；未列/新增/截断文件不登记。
- **路径冲突**：`path_norm` 已属于另一个 item → 预检返回 `pathCollision`，导入 409；本轮不新增“移动旧 owner”，合并走既有入口。
- **预算/取消/未知**：总字节/时间预算；超限/取消 → `unknown`；不以名称/尺寸降级为 `exact`。
- **TOCTOU**：导入时按 `expected` 重验（带 `sha256` 则强制重算）；残余窗口明说，不声称消除。
- **下载两阶段**：主 UI 全部 `stage=true`；commit 只收服务端发放的 opaque token（绑定路径/商品/size/mtime/hash/过期/消费/重启），不收任意路径；跳过不自动删文件。
- **元数据 ≠ 素材入库**：BOOTH 元数据抓取失败不影响预检结论，也不阻断入库。
- **合并关系迁移**：同一事务内先迁 asset，再 `UPDATE asset_version_links SET item_id=target`；保留 id/state/version；不用 `INSERT OR IGNORE + DELETE`（会丢行）。
- **资产归属变更**：所有 owner 变更调用点共用检查（带关系 → 409），合并用 `ctx.merge` 放行并在事务末断言；明确这是应用层保证，不是任意 SQL 的保证。
- **link-booth merge（N2）**：复用共享事务迁 assets + version links；不改成全量 `mergeItems`，保留“移资产 + 软删本地 item”旧语义。
- **scan 文件级跳过（N2）**：批次内一个文件带关系冲突 → 跳过该文件 + 事件，不失败整批，不建空 item。
- **预校验时序（N3）**：`expected`/哈希/`pathCollision` 先于 `createItem`/`registerAssets`/`importBoothUrl`；组内全拒不建空 item；残余窗口明说。
- **stage 只读（N3）**：只下载 + 只读预检 + 只读 `fetchItem` 元数据；不建 item/image/tag。
- **commit 原子（N4）**：token 验证/重算在 SQLite 事务外；nonce 消费 + item/asset 登记同事务；回执表重放返回已入库指针，不重复登记。
- **commit 重验归属（P2-1）**：同一事务、登记前重验 `path_norm`；属于另一个 item（含新建意图）→ 409 `PATH_OWNED_BY_OTHER_ITEM`；不借 `upsertAsset` 静默改 owner；stage 后占用也挡；回执重放优先。
- **重放语义（P2-2）**：同 token → 200 `{replayed:true,...}` 指针；同 nonce 异 token_hash → 409 `STAGE_TOKEN_CONSUMED`；已提交 import 指针 NULL → 410，不重建；skip 空指针仍 200。
- **commit 并发重查（P2-4）**：`BEGIN IMMEDIATE` 后、任何写/归属检查/回执登记之前，按 nonce 重查回执；同 token_hash → 200 指针，异 → 409 不返回指针；事务内无 `await`、无通用 catch、失败全回滚可重试；事务外快路径保留。
- **attach-only（P3-6）**：提交后只允许 `attachBoothMetadata` 给已存在 item 附加元数据/图片/标签/分类；禁止 createItem/moveAssets/改 owner；失败 best-effort。

### 5.2 搭配清单

- **一个模型多份清单**；清单名模型内唯一。
- **按 item 添加**；`(loadout_id, item_id)` 主键；同一 item 多清单/多模型状态独立。
- **手动状态**：`planned/imported/verified`，无状态机；不写回 `items`。
- **兼容 ≠ 使用意图**：不自动从 `item_avatars` 填充；`exclude` 不是“已加入”。
- **声明与证据分层**：`project_imports`（登记）/ `project_refs`（引用）/ `import_runs.verified`（校验）只读展示，不自动改写清单状态。
- **不启动 Unity**：清单 CRUD 不建导入计划、不写 `project_imports`。
- **ABA 防护**：删除是墓碑（`deleted_at` + `version+1`），重加再 `version+1`；旧 `expectedVersion` 永远 409。
- **counts 拆分**：`stateCounts`（清单状态）与 `trashedCount`（item 在回收站）分开。
- **reorder**：支持“只提交可见行”（隐藏行稳定追加）与“全量”两种形状；空可见集 `[]` 是 no-op。
- **merge 6 格表（N1）**：target 活跃/墓碑/无行 × source 活跃/墓碑；不物理删除 source、不改 source key；target 行 version=`max+1`；source 活跃行转墓碑 +1，source 已墓碑原样保留；防 source ABA。
- **merge 范围（P3-2）**：`mergeItems` 对每个含 S 或 T（至少一个）的清单逐个应用 6 格表；S、T 都不含的清单不变；source 无行时 target-only 活跃/墓碑均 no-op（不碰 version/position/timestamp）；link-booth 仍不迁清单。
- **position MAX（P3-8）**：复活/重加 `position=MAX(活跃行)+1`；墓碑行不参与 MAX。
- **`includeTrashedItems`**：只指 item 当前在回收站，不指 `loadout_items.deleted_at` 墓碑；墓碑行永不返回。
- **counts 三口径**：`stateCounts` 含回收站 item；`visibleStateCounts` 不含；`trashedCount` 是 item 在回收站的子集。
- **复活 position**：重加墓碑行 `position=MAX(活跃行)+1`，放末尾；墓碑行不参与 MAX。

### 5.3 整理待办

- **四类规则**：`missing_cover`（没有可解析的 `cover_image_id` 且没有自己的图；cover 指向外 item 不算缺，悬空算缺）、`missing_source`（`source_url` 为空/空白且 `source_gone=0`；空白用 `TRIM(X, charlist)` 剥制表符/换行）、`unlinked_model`（无 any/all 行，`exclude` 不算；只看 item 级）、`missing_file`（`assets.status='missing'`，不 stat 磁盘）。
- **默认排除 archived/trashed**；保存筛选没有 `includeArchived/includeTrashed` 字段，出现即 400。
- **忽略 `(item, rule)`**：只写 `cleanup_ignores`；不改素材字段；可恢复。
- **忽略可见**：`GET /api/cleanup/ignores` 独立列出全部忽略并求 `resolved`；`ignored=only` 也返回已解决行，UI 可恢复陈旧忽略。
- **ignored=only 口径**：顶层 `total` = 当前列表行数（忽略表驱动）；`counts` = 规则命中计数（不受 `ignored` 影响）；两者可以不同，UI 分页用 `total`、tab 用 `counts`，文案注明。
- **local 策略**：唯一新增口径，显式参数 `exclude_local` / `include_local`；**用户已选 `include_local`（m00868），主 UI 默认选中并显式传参；API 仍必填、无服务端默认**；响应带 `localExcluded` 计数；已知不足写清（无法区分本地自制与未识别 BOOTH）。
- **ignores 同口径（P2-3）**：`GET /api/cleanup/ignores` 必填 `localSourcePolicy`；缺失 400 `LOCAL_POLICY_REQUIRED`；`resolved` 的 `missing_source` local 分支按该策略求值，其余三规则不受影响。
- **待办派生**：不落待办行；规则变化/资产变化自然反映。
- **保存筛选**：结构化 JSON、严格校验、参数化 SQL；不拼字符串。

## 6. 验收总表（每份子设计的详细正反例见各自 §11/§10）

| 子设计 | 必须通过的最小验收 |
|---|---|
| 预检 | exact 只由“stat 一致 + 本次重算相等”得出；保持时间戳的改写不 exact；预算不足不 exact；同商品不同字节不是 exact；版本不可解析不猜；预算/取消 → unknown；跳过不登记；接受列表外的文件不登记；截断/新增文件不登记；pathCollision → 409；导入 `expected` 不匹配 → 同步入口 409、作业入口记 `PRECHECK_STALE` 失败且不登记；组内全 stale 不建空 item；版本关系确认/更正/撤销/再确认/降回 candidate 持久化；合并后关系行数不变且 item_id=target；link-booth merge 迁关系；scan 文件级冲突跳过；带关系资产直接改归属 → 409；stage 只读不建 item/图；stage token 重放/篡改/重启失效；commit 失败回滚可重试；commit 重验 pathCollision（占用 409、owner 不变）；并发同 token 事务内重查 200 指针；并发异 token 409；事务内无 await；同 token 重放 200 指针；同 nonce 异 token 409；已提交指针 NULL 410；attach-only 不建 item/不迁资产；同商品不建第二个 item；预检前后 DB 行数不变 |
| 清单 | 同模型 2 份清单；同 item 不同清单/不同模型状态独立；重启仍在；证据变化不改状态；状态变化不写证据；合并 6 格表（target 活跃/墓碑/无行 × source 活跃/墓碑）都不 PK 冲突、target version=max+1、source 活跃转墓碑 +1、source 已墓碑不变；mergeItems 对所有含 S 或 T（至少一个）清单逐个应用；source-only 活跃迁移/墓碑 no-op；target-only 活跃/墓碑 no-op；删除重加后旧 expectedVersion 409；counts 三口径分开；reorder 可见行/全量/空可见集；复活 position=MAX(活跃行)+1；删除清单/模型不删素材；GET 纯读 |
| 待办 | 四类规则正反例（含 `all`、asset 级证据、制表符空白、cover 指向外 item/悬空）；忽略/恢复；忽略不改素材；默认排除归档/回收站；保存筛选不能扩大范围；`q` 注入无效；陈旧忽略 `resolved:true` 可见可恢复；`ignored=only` 的 `total` 与 `counts` 口径分开；local 策略两种取值与 `localExcluded` 计数；ignores 必填 localSourcePolicy（缺失 400）；exclude/include 下 local missing_source 的 resolved 正反例；其他三规则不受 local 策略影响；重启仍在；GET 纯读 |

## 7. 阶段依赖与实施顺序

```text
概念批准（已完成，approval-20261104.md）
  → 三份书面 spec（已完成，用户 m00868 书面批准）
  → writing-plans 产出实施 plan（本组 plans/，待用户确认）
  → 用户确认 plan
  → schema v10 单一 owner 落地（三节 DDL）
  → 三个子项目可并行/串行实现（互不依赖）
  → 各自验收 + 统一报告
```

- **书面 spec 批准**不等于 **plan 批准**，更不等于实施批准。
- **schema v10** 是共享前置；建议先落地（或与第一个子项目一起），避免三个实现者各自改迁移。
- 三个子项目之间没有数据依赖；实现顺序可按用户优先级调整。
- 本轮只写文档：不写 plan、不写产品/测试代码、不安装/构建/测试/生产请求/SQLite/素材/缓存/Unity/启停/发布/提交推送。

## 8. 语义选择（已裁定 / 仍待审阅）

### 8.1 已裁定（用户 m00689 已批准或父已裁定，不再问）

| 子设计 | # | 选择 | 结论 |
|---|---|---|---|
| 预检 | D1 | 下载 `stage=true` 是否默认 | 主 UI 全部默认开启；API 不传保持 legacy |
| 预检 | D3 | exact 是否要求哈希新鲜 | 是，且判据改为 stat + 本次重算 |
| 预检 | D4 | 版本关系是否只做同一 item 内 | 是（资产级） |
| 预检 | D5 | 版本关系删除是软撤销还是硬删 | 软撤销 + 可选硬删候选 |
| 清单 | D1 | 清单粒度 | item 级（已批准） |
| 清单 | D2 | 状态枚举 | `planned/imported/verified`（已批准） |
| 清单 | D3 | 合并冲突 | target 赢（已批准） |
| 清单 | D4 | 回收站 item 默认 | 隐藏 + 计数 |
| 清单 | D5 | 证据一键改状态 | 否（只读） |
| 待办 | D1 | 忽略粘性 | 粘性 |
| 待办 | D2 | `source_gone` 分开 | 分开 |
| 待办 | D3 | `exclude` 不算 | 不算 |
| 待办 | D4 | 保存筛选范围 | 不含归档/回收站（已批准） |
| 待办 | D5 | 无资产条目 | 包含 |
| 预检 | — | commit 归属重验 | 同事务、登记前；占用 409；回执重放优先（P2-1） |
| 预检 | — | 重放语义 | 同 token 200 指针；同 nonce 异 token 409；指针 NULL 410（P2-2） |
| 预检 | — | commit 并发重查 | `BEGIN IMMEDIATE` 后、任何写之前按 nonce 重查回执；同 token 200 指针、异 token 409；事务内无 await（P2-4） |
| 待办 | — | ignores 的 local 策略 | 必填，与 todos/保存筛选同口径（P2-3） |

### 8.2 已裁定（m00868）与剩余实现细节

| 子设计 | # | 选择 | 状态/默认 | 备选 |
|---|---|---|---|---|
| 预检 | D2 | 跳过决策是否写审计 | 否（纯客户端跳过） | 是（新增 skip 审计端点） |
| 待办 | D6 | local 条目是否算“缺来源” | **用户已选 `include_local`（m00868）**；主 UI 默认选中并显式传参；API 仍必填无默认 | `exclude_local` 仍合法 |

其余实现细节（墓碑、reorder 形状、counts 拆分、触发器演进、token 语义）按各子设计默认执行，不再逐项询问。

## 9. 明确不做（三份共同）

- 不做 AI/云/自动 Unity/后台扫描引擎。
- 不做自动合并、自动跳过、自动改归属。
- 不做新 job kind、不改 job 状态机、不改 `planHash`/`change` 枚举。
- 不新增 npm 依赖。
- 不删除/移动源文件。
- 不把概念批准当成书面 spec/plan/实施批准。

## 10. 事实与建议

- **事实**：三份子设计的“现状事实”表与 `file:line` 引用；本总览 §3.1、§4.1 的冻结/版本事实。
- **建议**：三份子设计的 DDL、端点、UI、验收；本总览 §4-§8 的迁移/顺序/选择。均未执行。
- **未执行验证**：本轮未跑测试、未构建、未启动服务、未读生产 DB、未访问真实素材、未启停 Unity、未提交/推送。

## 11. revision-1 修订记录

| 项 | 修订 |
|---|---|
| P1-1 | 合并关系迁移改为 `UPDATE item_id`（保留 id/state/version）；`INSERT OR IGNORE + DELETE` 只留给 loadouts/ignores |
| P1-2 | 导入改为“接受列表 + 每文件 expected”；执行不递归；未列/新增/截断不登记 |
| P1-3 | exact 改为 stat 一致 + 候选本次重算；`last_verified_at` 不再当哈希时间 |
| P2-1 | 资产归属变更共享检查（带关系 → 409）；合并 `ctx.merge` 放行 + 事务末断言；明说不是任意 SQL 保证 |
| P2-2 | 删除 `rehash` 参数；`expected.sha256` 存在即强制重算 |
| P2-3 | 预检加 `pathCollision`；导入 409；不新增“移动旧 owner” |
| P2-4 | commit 只收 opaque token；服务端绑定路径/商品/size/mtime/hash/过期/消费/重启 |
| P2-5 | loadout_items 墓碑 + 单调 version，挡 ABA |
| P2-6 | `GET /api/cleanup/ignores` 独立列出全部忽略并求 `resolved`；`ignored=only` 返回已解决行 |
| P2-7 | local 策略显式参数 + `localExcluded` 计数 + 已知不足 |
| P2-8 | 冻结面措辞改为“既有表/API 形状保持，新增 additive，需批准改 schema.sql/migrate.ts” |
| P2-9 | 主 UI 下载全部默认 `stage=true`；明确 source 失败/skip 留存/取消/确认步骤 |
| P3-1 | `TRIM(X, charlist)` 剥制表符/换行 |
| P3-2 | `unlinked_model` 明说只看 item 级；补 `all` 与 asset 级反例 |
| P3-3 | `stateCounts` 与 `trashedCount` 拆开 |
| P3-4 | reorder 支持可见行/全量两种形状 |
| P3-5 | 版本关系状态转移表（含 revoked→confirmed） |
| P3-6 | 普通恢复 ≠ 合并后恢复 |
| P3-7 | 手动挂载改为“路由内同步重验” |
| P3-8 | `loadouts.version` 只保护 name/note/sort |
| P3-9 | 触发器演进需 DROP + CREATE |

## 12. revision-2 修订记录

| 项 | 修订 |
|---|---|
| N1 | loadout merge 改为 6 格表：target 活跃/墓碑/无行 × source 活跃/墓碑；不物理删除 source、不改 key；version=max+1；source 墓碑保留；复活 position 末尾 |
| N2 | 抽出共享事务“迁 assets + 迁 version links”供 mergeItems 与 moveAssets/link-booth 复用；link-booth 不改成全量 merge；scan 文件级冲突跳过 + 事件 |
| N3 | expected/哈希/pathCollision 先于 createItem/registerAssets/importBoothUrl；stage 只读 fetch 元数据、不建 item/image/tag；组内全拒不建空 item；残余窗口明说；legacy 兼容 |
| N4 | 新增 `import_stage_commits` 技术回执；token 验证/重算在外，nonce 消费 + item/asset 登记同事务；失败回滚可重试；重放返回指针；重启 epoch/回执协调；skip 不写审计 |
| P3-5 | PATCH state 允许 candidate/confirmed/revoked，与转移表一致；candidate 是人工声明，不冒充 proven |
| P3 局部 | includeTrashedItems 命名；空可见集 reorder no-op；复活 position 末尾；stateCounts/visibleStateCounts/trashedCount 三口径；missing_cover 与真实卡片可见一致；ignored=only total/counts 分开；basis 是客户端回传枚举 |

## 13. revision-3 修订记录

| 项 | 修订 |
|---|---|
| P2-1 | download commit 在同一 SQLite 事务内、任何 receipt/item/asset 写之前重验 `path_norm` 归属；占用 → 409 `PATH_OWNED_BY_OTHER_ITEM`；不借 `upsertAsset` 静默改 owner；stage 后占用也挡；回执重放优先 |
| P2-2 | 同 token 重放统一为 200 `{replayed:true,...}` 指针；同 nonce 不同 token_hash → 409 `STAGE_TOKEN_CONSUMED`，不返回他人指针；按 nonce 查回执、比较 sha256(token) |
| P2-3 | `GET /api/cleanup/ignores` 必填 `localSourcePolicy`（缺失 400 `LOCAL_POLICY_REQUIRED`）；`resolved` 的 `missing_source` local 分支按该策略求值；其余三规则不受影响 |
| P3-1 | source 已墓碑不递增；source 活跃转墓碑才 +1 |
| P3-2 | `mergeItems` 对所有同时含 S/T 的清单逐个应用 6 格表；link-booth 仍不迁清单 |
| P3-3 | 回执查询措辞改为“用 nonce 查、比较 token_hash” |
| P3-4 | 回执存在但 token_hash 不同 → 409 `STAGE_TOKEN_CONSUMED` |
| P3-5 | 错误子码放 additive 可选 `details.code`；不新增外层 `AppErrorCode`；`contracts.ts` 的 details 字段属限定冻结面，只写设计未改 type |
| P3-6 | 提交后 attach-only：`attachBoothMetadata` 禁止 createItem/moveAssets/改 owner；失败 best-effort |
| P3-7 | 已提交 import 回执指针 NULL → 410 `STAGE_COMMITTED_OBJECT_DELETED`，不重建；skip 空指针仍 200 |
| P3-8 | `position=MAX(活跃行)+1`；墓碑行不参与 MAX |
| P3-9 | stage 只读旧探针只比较 before/after，标为弱证据；新 probe 实际执行 stage 编排并用写钩子 fail-fast |
| P3-10 | `asset_units.item_id` 不在共享事务范围；只列边界，不修旧功能 |

> 注：§13 的 P3-9 行是 revision-3 当时的声明；review-r3 已用副本 mutation test 证明 attach/stage 写钩子未接线、无辨别力，revision-4 撤销该强证据（见 §14）。

## 14. revision-4 修订记录

| 项 | 修订 |
|---|---|
| P2-4 | download commit 在 `BEGIN IMMEDIATE` 后、任何写/归属检查/回执登记之前按 nonce 重查回执；同 token_hash → 200 指针（已删 NULL 410、skip NULL 200），异 → 409 不返回指针；事务内无 `await`、无通用 catch、失败全回滚可重试；事务外快路径保留 |
| review-r3 §5.1 | loadouts 措辞统一为“含 S 或 T（至少一个）”；6 格表补 source 无行（target-only 活跃/墓碑 no-op）与两边无行 no-op；补 B9j–B9m |
| review-r3 §5.2 | 撤销 revision-3 探针的 hook 强证据（未接线、无辨别力）；只保留设计文字约束，stage/attach 写隔离留实施期 mutation 测试 |
| review-r3 §5.3 | 三处 `code=` 统一为外层 `CONFLICT`/`INVALID_INPUT` + `details.code` |
| review-r3 §5.4 | 明确行为探针是简化 schema，不是 DDL 校验；r2 的 DDL 7/7 是历史独立证据，不重算 |
| review-r3 §5.5 | 补 todos/saved-filter 缺 `localSourcePolicy` 的最小参数形状负例（C27b/C27c），非产品端点验收 |
| review-r3 §5.6 | r2 的 source 墓碑 RULE 提示已过期，不再作为当前 finding |
| review-r3 §5.7 | 回执先以 NULL 指针插入，登记后同事务 UPDATE 指针 |
