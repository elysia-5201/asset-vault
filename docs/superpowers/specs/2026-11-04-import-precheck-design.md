# 导入前预检与版本关系设计（Feature 1）

- 日期：2026-11-04（revision-4）
- 状态：用户书面设计已批准（m00868，2026-11-04）；待实施计划确认；未开始实施
- 范围：导入前的只读预检（精确重复 / 同商品 / 版本候选 / 配套候选）与版本关系的人工确认、更正、撤销、持久化
- 读者：用户、lead、实现者、验证者
- 关联：总览 `2026-11-04-feature123-design.md`；盘点证据 `/root/Code/.asset-vault-feature123-20261104/discovery/import/report.md`
- 实施计划：[`../plans/2026-11-04-import-precheck-implementation.md`](../plans/2026-11-04-import-precheck-implementation.md)
- 修订：revision-1 修 P1-1（合并丢关系）、P1-2（目录导入绕过跳过）、P1-3（假 exact）、P2-1/P2-2/P2-3/P2-4/P2-9、P3-5/P3-6/P3-7/P3-9；revision-2 修 N2（link-booth 共享事务 + scan 文件级跳过）、N3（预校验先于一切登记、stage 只读、分组不建空 item）、N4（nonce 消费 + 入库同事务、回执重放、重启语义、fault injection）、P3-5（PATCH 三态与转移表一致）、basis 措辞；revision-3 修 review-r2 的 P2-1（commit 同事务重验 pathCollision）、P2-2（同 token 重放 200 指针 / 同 nonce 异 token 409）、P3-5（错误子码 details.code）、P3-6（attach-only 契约）、P3-7（回执指针失联 410）、P3-10（asset_units 边界）与 P3 局部澄清。原 review 报告 `design/review/report.md` 的探针保留不动。revision-4 修 review-r3 的新 P2（并发同 token 在事务内重查回执）与 7 项 P3 局部澄清（merge 措辞/6 格表补 source 无行、hook 证据撤销、子码记法、DDL 探针边界、todos/saved-filter 缺参、r2 旧提示过期、回执 NULL 指针顺序），不扩架构。

> 本文只写设计，不改产品代码、不改 `packages/core/src/contracts.ts`、`apps/server/src/db/schema.sql`、`apps/server/src/db/migrate.ts`、`docs/api.md`。文中的 DDL/端点/字段都是**建议**，实施前需书面 spec 与 plan 分别批准。

## 1. 目标与不变量

### 1.1 目标

在文件**登记进库之前**回答四个互相独立的问题，并让用户决定：

1. 这个文件的字节是否与库中某个资产**完全相同**（精确重复）？
2. 这个文件是否属于库中**同一个商品**（同 source item）？
3. 如果是同商品的不同文件，它是否可能是**新/旧版本**？
4. 如果不是版本，它是否可能是**配套文件**（材质、适配、DLC、变体）？

预检只提示，不自动合并、不自动跳过、不自动改归属。用户可以选择跳过（不登记）、仍然导入、关联到已有条目、标记版本关系。

### 1.2 硬不变量

- **精确 sha256 ≠ 同商品 ≠ 版本已证实**。三者是独立维度，任何一项都不能由另一项推出。
- **文件名、标题、大小、相似度不得单独推出“同版本”或“新版本”**。`parseVersionKey` 只是候选抽取器，不是证据。
- **不创建第二个同 `(source_site, source_item_id)` 的 item 来绕唯一索引**（`apps/server/src/db/schema.sql:60`）。同商品的新文件只能作为同一 item 下的新 asset。
- **旧文件保留**。预检、导入、版本确认都不删除、不移动、不覆盖旧 asset；替换/删除是另一个显式动作。
- **预检只读**。不写 items/assets/asset_signatures/scan_preview_*，不建 job，不写缓存，不调用任何会写库的查重函数。
- **自动流程不合并**。预检不调用 `mergeItems`（`apps/server/src/db/repo.ts:576`）；合并仍只走显式 `POST /api/items/merge`。
- **link 不暗改旧资产归属**。把新文件关联到已有 item 只新增 asset 行，不改旧 asset 的 `item_id`，不迁移旧 asset。若 `path_norm` 已存在且属于另一个 item，导入路径**不得**直接调用 `upsertAsset`（`repo.ts:402-415` 会把 `item_id` 改成新 item）；必须先提示用户，由用户显式选择“保留原归属”或走既有合并入口。
- **接受列表即契约**。预检接受后，导入只登记“用户接受并逐条带 expected 的文件列表”；执行阶段不再递归原目录，未列文件、预检后新增文件、截断未展示文件一律不登记（§6.3）。
- **exact 必须由本次现算的字节相等得出**。库中候选必须同时通过“磁盘 stat 与库内 size/mtime 一致”和“本次重算 sha256 相等”；预算不足时降级为 weak，不称 exact（§3.1）。
- **预校验先于一切登记（N3）**：`expected`/哈希/`pathCollision` 必须在 `createItem`、`registerAssets`、`importBoothUrl`、任何 `items/assets/item_images/tags/categories` 写之前完成；失败文件不产生任何行。
- **stage 只读（N3）**：`stage=true` 只下载文件、只读预检、只读 `booth.fetchItem` 元数据；不调用 `importBoothUrl`，不建 item/image/tag，不写分类。
- **commit 原子（N4）**：token 验证/重算在 SQLite 事务外；nonce 消费 + item/asset 登记在同一个 SQLite 事务内；任一步失败整体回滚、nonce 未消费、可重试；重放返回已入库指针，不重复登记。
- **commit 重验归属（P2-1）**：commit 在消费 nonce、建 item、登记 asset 之前，必须在同一 SQLite 事务内重验 `path_norm` 归属；属于另一个 item（含目标为新建意图）→ 409 `PATH_OWNED_BY_OTHER_ITEM`，不登记、不消费 nonce。已提交回执的重放优先于该检查。
- **commit 并发重查（P2-4）**：`BEGIN IMMEDIATE` 取得写锁后、任何写/归属检查/回执登记之前，必须在同一事务内按 nonce 再查一次回执；命中且 `token_hash` 相同 → 200 指针（已删 NULL 410、skip NULL 200），不同 → 409 且不返回指针；未命中才继续。事务内不得有 `await`；不得用通用 catch 掩盖真实 SQLite 错误；失败整体回滚、可重试。

## 2. 现状事实（只读核对）

| 事实 | 证据 |
|---|---|
| `items` 对 `(source_site, source_item_id)` 唯一（`source_item_id` 非空时） | `apps/server/src/db/schema.sql:60` |
| `items.source_site` 默认 `'local'` | `apps/server/src/db/schema.sql:35` |
| `assets` 以 `path_norm` 为身份；`sha256`/`sha256_state` 是内容哈希与状态 | `apps/server/src/db/schema.sql:81-107` |
| 内容哈希在登记**之后**的流水线 `hash` 阶段才算 | `apps/server/src/services/pipeline/stages.ts:173` 附近 |
| 三条直接导入入口登记前不做内容哈希查重 | `apps/server/src/http/routes.ts:386`（手工挂载）、`:736`（本地路径）、`:1734`（下载） |
| 扫描预览只有“同名 + 同尺寸”的弱提示 `duplicate_suspected`，只提示不合并 | `apps/server/src/services/scanpreview.ts:106-112` |
| 登记后查重：`computeSignature` 会 upsert `asset_signatures`；`findDuplicatesForItem` 可能触发它 | `apps/server/src/services/dedupe.ts:125`、`:201` |
| `fingerprintOf` 读签名/缓存清单，本身不写，但紧邻写路径且依赖已缓存清单 | `apps/server/src/services/dedupe.ts:145` |
| 版本抽取 `parseVersionKey` 从文件名/标题抽 `1.2` 这类串 | `packages/core/src/dedupe.ts:82` |
| 版本比较 `parseVersion`/`compareVersions` 是 semver 口径，当前只用于应用更新检查 | `packages/core/src/version.ts:35`、`:108` |
| 流式哈希 `sha256FileChunked` 支持取消、超时、进度、常量内存 | `packages/core/src/hash.ts:77` |
| 商品号识别 `identifyFromNames` 从文件名/目录名抽 BOOTH 号 | `packages/core/src/identify.ts:111` |
| 扫描应用前只做 size+mtime 重验，不重哈希 | `apps/server/src/services/scanpreview.ts:237-261` |
| `upsertAsset` 对已存在路径会 `UPDATE assets SET item_id=?`，并写 `last_verified_at=now()` | `apps/server/src/db/repo.ts:402-415`（`:411`） |
| `touchAsset` 在索引结束时写 `last_verified_at`；`setAssetSha` **不写** `last_verified_at` | `apps/server/src/db/repo.ts:681`、`:682` |
| `mergeItems` 先 `UPDATE assets SET item_id=target WHERE item_id=source`，再处理其它关系 | `apps/server/src/db/repo.ts:576-654` |
| 契约冻结：`contracts.ts`、`schema.sql`+`migrate.ts`、`api.md` | `docs/CONTRACT.md:5-8` |
| 路径/名称相似不是合并依据；自动流程不调用 `mergeItems` | `docs/CONTRACT.md:31` |
| 当前 `SCHEMA_VERSION = 9` | `apps/server/src/db/migrate.ts:11` |

## 3. 判定口径

### 3.1 精确重复（exact）

`exact` 必须同时满足四条，缺一条就不是 exact：

1. **入参现算**：预检时对入参文件流式现算全文件 SHA-256（`sha256FileChunked`，常量内存）。
2. **库中状态可用**：候选 `assets.sha256_state='ok'` 且 `sha256` 非空。
3. **磁盘元数据一致**：对候选 `assets.path` 做只读 `stat`，要求 `stat.size == assets.size` 且 `stat.mtime == assets.mtime`（按同一 ISO 字符串口径比较）。不一致 → 候选的库内哈希已不能代表磁盘内容，**不得** exact。
4. **候选本次重算**：对候选文件同样流式重算 SHA-256（同一预算内），要求等于入参哈希。不相等 → 不得 exact。

判定结果：

| 情形 | 结果 |
|---|---|
| 1+2+3+4 全通过 | `exact`，`hashFresh: true` |
| 2 通过、3 不通过 | `weak.reason="existing_hash_stale"`（磁盘已变或库内元数据过期） |
| 2+3 通过、4 因预算/取消未执行 | `weak.reason="existing_hash_unverified"`（**不称 exact**） |
| 2+3 通过、4 执行且不相等 | `weak.reason="existing_hash_mismatch"`（内容已变，库内哈希陈旧） |
| 2 不通过（`sha256_state<>'ok'` 或哈希为空） | 不参与 exact 比较 |

**`last_verified_at` 不是哈希新鲜度证明。** 它由 `upsertAsset`（`repo.ts:411`）和 `touchAsset`（`repo.ts:681`，索引结束时调用）写入，而 `setAssetSha`（`repo.ts:682`）不写它；它记录的是“这行最近被扫描/索引过”，不是“哈希是在文件当前内容之后算的”。因此本设计**不使用** `last_verified_at >= mtime` 作为判据。

**反例（必须被挡住）**：

- **R1 磁盘已变、库未重扫**：asset A 在 T1 扫描，DB `mtime=M1`、`sha256=H1`；文件在 T3 被改（磁盘 `mtime=M2`），尚未重扫。入参 B 的字节等于 H1。旧口径（`last_verified_at>=mtime`）会返回 exact 指向 A，但 A 当前字节已不是 H1。新口径：第 3 条 stat 不一致 → `existing_hash_stale`。
- **R2 保持时间戳**：文件被改写但 `mtime` 被保留（`touch -r`、`cp -p`、解包工具保留时间），且 size 恰好相同。第 3 条通过，第 4 条重算不相等 → `existing_hash_mismatch`，不 exact。
- **R3 预算耗尽**：候选很多、总预算用完，第 4 条没跑。返回 `existing_hash_unverified`，不 exact；不得用“名称+尺寸”或“库内缓存哈希”冒充 exact。

**残余 TOCTOU（明说）**：候选重算完成到登记事务提交之间，文件仍可能被再次修改。本设计**不声称**这段窗口绝对不存在。可做的只有：登记时按 `expected` 再验一次（size+mtime；带 `sha256` 时强制重算），把窗口压到“最后一次读取 → INSERT”之间；这段窗口无法用文件系统 API 消除。

### 3.2 同商品（same-product）

- 从入参路径的文件名与祖先目录名调 `identifyFromNames` 抽 BOOTH 商品号；抽不到就不猜。
- 与库中 `items.source_site='booth' AND source_item_id=<抽到的号>` 匹配 → `sameProduct`。
- 同商品是**身份**，不是版本；同商品不同字节 ≠ 重复，同商品同字节也只是“恰好同字节”。
- 已 `trashed` 的 item 仍返回（带 `status`），由 UI 决定是否提示“回收站中已有同商品”。

### 3.3 版本候选（version-candidate）

- 仅在 `sameProduct` 成立时计算。
- 双方都要有可解析的版本键：
  - 入参：`parseVersionKey(basename(path))`，失败再尝试标题（若调用方给了 `source.title`）；
  - 库中：在该 item 下 `status<>'trashed'` 的 asset 里，取版本键可解析且最大的一条作为比较对象（`asset_signatures.version_key` 优先，缺失时 `parseVersionKey(basename(asset.path))`，再失败用 item 标题）；都不可解析时取 `first_seen` 最新的一条作为弱候选，`relation="unknown"`。
- 双方都能 `parseVersion` 才比较；任一方不能解析 → `relation="unknown"`，不猜。
- `compareVersions` 结果映射：`>0` → 入参更新（`newer`）、`<0` → 入参更旧（`older`）、`=0` → `same`。
- 返回 `proven: false` 与 `basis: "filename"|"title"`。**文件名/标题只是候选依据，不是版本证明**。
- 版本关系是**资产级、同一 item 内**：入参文件登记后成为该 item 的新 asset，关系指向“入参 asset ↔ 已有 asset”。不跨 item 建版本关系；跨商品的“疑似同商品”仍走现有 `GET /api/items/:id/related`（`docs/api.md:53-68`）。

### 3.4 配套候选（companion-candidate）

- 仅在 `sameProduct` 成立、且不构成版本候选时计算。
- 命中配套标记词（与 `related` 的噪音词表同源：material/材质/マテリアル/texture/モデル/本体/readme/dlc/set 等）→ `companion.markers`。
- 配套是候选，不是结论；用户可确认、可改成版本关系、可忽略。

### 3.5 未知（unknown）

- 哈希失败、超时、取消、不可读、超过单文件上限、超过总预算 → `hash.state="unknown"` + `reason`。
- `unknown` 时**不得**降级成 `exact`；最多给 `weak.reason="name_size_hint"`（同名同尺寸），并明确标注“不是精确重复”。
- 预检失败不阻断导入流程：用户仍可选择“仍然导入”，导入路径照旧可用。

### 3.6 路径冲突（pathCollision）

- 入参 `path_norm` 在 `assets` 中已存在时，预检必须返回 `pathCollision`：
  - 属于**另一个** item → `{itemId, assetId, path, pathNorm, sameItem:false}`；
  - 属于**同一个** item → `{..., sameItem:true}`（幂等，不构成冲突）。
- 预检只报告，不写库、不改归属。
- 导入时若 `path_norm` 已属于另一个 item → 409 `CONFLICT`（`details.code="PATH_OWNED_BY_OTHER_ITEM"`），**不登记**；本轮**不新增**“移动旧 owner”动作（§6.3）。
- commit 阶段同样重验（§6.4）：stage 之后路径才被占用也 409；不借 `upsertAsset` 的已存在分支静默改 owner。
- 同一 item 同一路径 → 沿用现状幂等（`upsertAsset` 更新 size/mtime，不新增行）。

## 4. 方案与取舍

### 4.1 候选方案

- **A（选用）只读预检端点 + UI 决策卡 + 接受列表导入**：`POST /api/import/precheck` 同步、有界、只读；UI 在调用导入端点前展示结果；用户接受后只把**展开后的文件列表 + 每文件 expected** 交给导入作业。版本关系落一张新表。
- **B 持久化预检作业 + 决策表**：新 job kind + 新表，决策成为闸门。需要改 `contracts.ts` 的 `JobKind`（冻结），代码面与测试面大；本轮不选。
- **C 扩展现有 scan preview 作为唯一闸门**：复用 preview/apply/planHash。会改 apply 的冻结语义（当前只登记/重索引/标缺失），且每次扫描都哈希成本高；不选。

### 4.2 选择理由

- A 不触碰 `contracts.ts` 的 job 状态机、不改 `planHash`/`change` 枚举、不改 `api.md` 既有响应形状；新增端点与可选字段都是 additive。
- A 的预检是“建议”不是“闸门”：即使 UI 被绕过，导入仍按现有路径工作；这符合“用户跳过/继续”的产品语义。
- 接受列表把“跳过”变成结构性保证：执行阶段没有目录遍历，就没有“遍历到未接受文件”的路径。
- 版本关系需要持久化，单独一张表即可；预检结果本身不落库，避免陈旧行。

## 5. 数据模型（建议，未执行）

### 5.1 新表 `asset_version_links`

同一 item 内两个 asset 的版本/配套关系。用规范顺序 `asset_a_id < asset_b_id` 避免 (A,B)/(B,A) 重复行。

```sql
CREATE TABLE IF NOT EXISTS asset_version_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  asset_a_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  asset_b_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('a_newer','b_newer','same','companion')),
  basis TEXT NOT NULL CHECK (basis IN ('filename','title','manual')),
  evidence_json TEXT,
  state TEXT NOT NULL DEFAULT 'candidate' CHECK (state IN ('candidate','confirmed','revoked')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  CHECK (asset_a_id < asset_b_id),
  UNIQUE (asset_a_id, asset_b_id)
);
CREATE INDEX IF NOT EXISTS ix_avlink_item ON asset_version_links(item_id, state);
CREATE INDEX IF NOT EXISTS ix_avlink_a ON asset_version_links(asset_a_id);
CREATE INDEX IF NOT EXISTS ix_avlink_b ON asset_version_links(asset_b_id);
```

关系方向：`a_newer` = `asset_a` 比 `asset_b` 新；`b_newer` = 反之；`same` = 同版本；`companion` = 配套，不是版本。

`UNIQUE (asset_a_id, asset_b_id)` 是**全局**唯一（不带 item_id）：同一对 asset 在全库只能有一条关系。这条约束正是 §10 合并必须用 `UPDATE` 而不是 `INSERT OR IGNORE` 的原因。

### 5.2 同一 item 的数据库级约束

SQLite 的 `CHECK` 不能子查询，`assets` 也没有 `(item_id,id)` 唯一索引（加它要动冻结表的索引集）。用触发器把不变量钉在库层：

```sql
CREATE TRIGGER IF NOT EXISTS trg_avlink_same_item_ins
BEFORE INSERT ON asset_version_links
FOR EACH ROW
WHEN (SELECT item_id FROM assets WHERE id = NEW.asset_a_id) IS NOT NEW.item_id
  OR (SELECT item_id FROM assets WHERE id = NEW.asset_b_id) IS NOT NEW.item_id
BEGIN
  SELECT RAISE(ABORT, 'asset_version_links: both assets must belong to item_id');
END;

CREATE TRIGGER IF NOT EXISTS trg_avlink_same_item_upd
BEFORE UPDATE OF item_id, asset_a_id, asset_b_id ON asset_version_links
FOR EACH ROW
WHEN (SELECT item_id FROM assets WHERE id = NEW.asset_a_id) IS NOT NEW.item_id
  OR (SELECT item_id FROM assets WHERE id = NEW.asset_b_id) IS NOT NEW.item_id
BEGIN
  SELECT RAISE(ABORT, 'asset_version_links: both assets must belong to item_id');
END;
```

触发器是 additive schema；它不改变既有表。

**为什么不在 `assets` 上加“改 item_id 就检查关系”的即刻触发器**：合并事务的中间态是“asset 已迁、关系还没迁”，逐行触发器会在中间态 ABORT，把合法合并拦死。SQLite 没有 deferred trigger。因此资产侧的保护放在**应用层共享检查 + 事务末断言**（§9.1），并明确它**不是**任意 SQL 的保证。

### 5.3 迁移与回退

- **单一 owner**：`SCHEMA_VERSION` 9 → 10 只 bump 一次；三份 spec 的表由同一个迁移 owner 一次性落地（见总览 §4）。本 spec 不拥有 `migrate.ts`。
- 迁移是幂等的：`CREATE TABLE IF NOT EXISTS` + `CREATE TRIGGER IF NOT EXISTS`；在 v9 库上创建，在 v10 库上 no-op。
- 不改既有表、不加列、不改索引；因此不需要 `COLUMN_MIGRATIONS` 条目。
- **触发器演进**：`CREATE TRIGGER IF NOT EXISTS` 对已存在的同名触发器是 no-op，**改定义不会生效**。以后修改触发器必须在新迁移里 `DROP TRIGGER IF EXISTS <name>;` 再 `CREATE TRIGGER <name> ...`；只改 `schema.sql` 文本对已迁移的库无效。
- **备份**：迁移前停止服务，复制 `vault.db`、`vault.db-wal`、`vault.db-shm`（只复制主库会因 WAL 重放不一致）。
- **回退**：停服务 → 恢复三件备份 → 启动旧二进制。**不声称无损 downgrade**：旧代码打开 v10 库会忽略多出的表，但会把 `schema_meta.version` 写回 9；这是不支持的状态，只能靠恢复备份。
- 迁移验收：v9 fixture 打开 → 迁移 → 表/索引/触发器存在、`schema_meta.version=10`、既有行数不变；再跑一次 no-op。

### 5.4 stage 回执表 `import_stage_commits`（N4）

```sql
CREATE TABLE IF NOT EXISTS import_stage_commits (
  nonce TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('import','skip')),
  item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
  asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_stage_commits_created ON import_stage_commits(created_at);
```

- 这是**技术回执**，不是产品新子系统：只用于 nonce 消费与“已入库指针”重放；不暴露产品 API，不写 `audit_log`。
- `nonce` 主键保证同一 token 只消费一次；`token_hash` 防止 nonce 碰撞/伪造回执。
- `decision='skip'` 也写回执（消费 nonce），但 `item_id/asset_id` 为 NULL，不建 item/asset。
- 迁移随 v10 统一 owner；`CREATE TABLE IF NOT EXISTS` 幂等；不改既有表。
- 清理：回执可按 `created_at` 定期清理（例如 30 天），清理不影响已入库数据；清理不是本轮实现范围，只写设计。
- `item_id`/`asset_id` 是 `ON DELETE SET NULL`：已提交 `import` 回执的指针失联时，重放返回 410 `STAGE_COMMITTED_OBJECT_DELETED`，不重建（§6.4）；`skip` 的空指针仍可成功重放。
- **回执写入顺序（P3-7 措辞）**：事务内先以 `item_id/asset_id = NULL` 插入回执占住 nonce，登记 item/asset 成功后再在同一事务内 `UPDATE` 真实指针；不得先建 item 再插回执（那会破坏“nonce 先占”的原子性）。

## 6. API 设计（建议，未执行）

### 6.1 预检端点

`POST /api/import/precheck`

- 用 POST 是因为路径列表可能很长，不适合 URL；**语义是纯读**：不写库、不建 job、不写缓存、不产生文件。
- 请求：

```json
{
  "paths": ["C:/Downloads/a.zip", "C:/Downloads/b"],
  "source": { "site": "booth", "itemId": "6115428", "title": "…" },
  "budget": { "maxBytes": 2147483648, "maxMs": 20000 }
}
```

- `paths` 必填，1..200 条；必须是绝对路径；目录会被只读展开（`walkCandidates`），**整个请求展开后的文件总数上限 500**，超出 `truncated=true`。
- `source` 可选，仅作为“用户已知商品号/标题”的提示；不作为证据。
- `budget` 可选，服务端夹紧到上限（默认总字节 4 GiB、总时间 20 s；单文件上限 2 GiB）。
- 响应：

```json
{
  "checkedAt": "2026-11-04T03:00:00.000Z",
  "budget": { "maxBytes": 2147483648, "maxMs": 20000, "usedBytes": 123, "usedMs": 45, "truncated": false },
  "results": [
    {
      "path": "C:/Downloads/a.zip",
      "pathNorm": "c:/downloads/a.zip",
      "group": { "rootPath": "C:/Downloads", "rootId": 1 },
      "size": 123,
      "mtime": "2026-11-04T02:00:00.000Z",
      "hash": { "state": "ok", "sha256": "…" },
      "match": {
        "exact": { "itemId": 1, "assetId": 2, "path": "…", "size": 123, "hashFresh": true, "rehashVerified": true },
        "sameProduct": { "itemId": 1, "sourceItemId": "6115428", "title": "…", "status": "active" },
        "version": { "relation": "newer", "incomingKey": "1.3", "existingKey": "1.2", "basis": "filename", "proven": false, "existingAssetId": 2 },
        "companion": null,
        "weak": null,
        "pathCollision": null
      },
      "summary": "exact",
      "warnings": []
    }
  ]
}
```

- `match` 的六个字段互相独立，可以同时非空（例如 exact + sameProduct + pathCollision）。`summary` 只是 UI 便利的派生值，优先级：`exact > version-candidate > companion-candidate > same-product > pathCollision > weak > unknown > none`。
- `group` 保留“这个文件是从哪个目录/根展开来的”，供 UI 分组展示与“整组跳过”；导入时原样带回，不用于递归。
- 单文件失败不导致整个请求失败：该条 `hash.state="unknown"` + `reason`，其余照常。
- 错误：`400 INVALID_INPUT`（paths 空/超 200/非绝对路径/budget 非法）；`500` 仅未预期异常。**不新增 `AppErrorCode`**。

### 6.2 版本关系端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/items/:id/version-links?state=candidate|confirmed|revoked&limit=&offset=` | 纯读；返回该 item 的关系，按 `updated_at DESC, id DESC`；limit 默认 50、上限 200 |
| POST | `/api/items/:id/version-links` | 建候选：`{assetAId, assetBId, relation: "a_newer"|"b_newer"|"same"|"companion", basis?, evidence?}`；服务端按 id 升序规范为 a<b，若交换了入参则把 `a_newer`/`b_newer` 对调；重复对 → 409 CONFLICT |
| PATCH | `/api/items/:id/version-links/:linkId` | 确认/更正/撤销：`{relation?, state?, expectedVersion}`；CAS 失败 → 409 CONFLICT |
| DELETE | `/api/items/:id/version-links/:linkId` | 删除候选记录（审计留痕）；已确认/已撤销也可删，但 UI 默认只对候选显示 |

- `GET` 响应：`{itemId, total, links: [{id, assetAId, assetBId, relation, basis, state, evidence, version, createdAt, updatedAt, decidedAt, assets: {a: {...}, b: {...}}}]}`。
- `POST` 的 `basis` 缺省为 `manual`（用户手动建的关系）；**预检结果里的 `basis` 只是建议值，不落库**。POST 接受客户端回传的 `basis`，服务端只校验枚举（`filename|title|manual`），不把“服务端写”当成事实。
- `PATCH` 的 `state` 允许 `candidate|confirmed|revoked`（与下方转移表一致）；`relation` 只允许四个枚举值。`expectedVersion` 必填，用于乐观并发。`candidate` 是**人工声明**（“尚未确认/撤回确认”），不冒充 `proven`，也不改写 `evidence`。
- **状态转移表**（P3-5）：

| 当前 \ 目标 | candidate | confirmed | revoked |
|---|---|---|---|
| candidate | 幂等 no-op | 允许 | 允许 |
| confirmed | 允许（降级为候选） | 幂等 no-op | 允许 |
| revoked | 允许（重新成为候选） | **允许（重新确认）** | 幂等 no-op |

  - 同状态 PATCH 是幂等 no-op：返回当前行，`version` 不递增，不写审计。
  - 每次真实转移 `version+1`、写 `decided_at`、写 `audit_log`。
  - `confirmed→candidate` / `revoked→candidate` 是允许的“撤回确认/重开候选”，只改 `state`，不把 `proven` 设为 true，也不删 `evidence`；`candidate→confirmed` 才是确认。
- 所有 mutation 在 `db.transaction` 内：更新 + `audit_log` 同一事务；0 行更新 → 409。
- 不新增错误码：重复/并发用 `CONFLICT`，参数用 `INVALID_INPUT`，不存在用 `NOT_FOUND`。
- **CAS 身份**：`id` 是 `AUTOINCREMENT`，SQLite 保证不复用；删除后重建得到新 `id`，旧 `(id, version)` 永远匹配不到新行。因此本表不需要额外的 generation/nonce。

### 6.3 导入端点的 additive 扩展（接受列表）

`POST /api/import/paths` 增加**新形状**（与旧形状并存）：

```json
{
  "files": [
    { "path": "C:/Downloads/a.zip", "expected": { "size": 123, "mtime": "2026-11-04T02:00:00.000Z", "sha256": "…" }, "group": { "rootPath": "C:/Downloads", "rootId": 1 } },
    { "path": "C:/Downloads/c.zip", "expected": { "size": 456, "mtime": "2026-11-04T02:00:01.000Z" }, "group": { "rootPath": "C:/Downloads", "rootId": 1 } }
  ]
}
```

规则：

1. **`files` 存在时，执行阶段不递归**：每个元素是一个文件路径；若某个 `path` 是目录 → 400 `INVALID_INPUT`（`DIRECTORY_NOT_ALLOWED_WITH_FILES`）。目录展开只发生在预检。
2. **每个元素必须带 `expected`**（`size` + `mtime` 必填，`sha256` 可选）。缺 `expected` → 400 `INVALID_INPUT`（`EXPECTED_REQUIRED`）。这样“只登记用户看过的文件”是结构性保证，而不是 UI 自觉。
3. **`expected.sha256` 存在 → 执行时强制重算 sha256 并比对**；不存在 → 只比对 size+mtime，作业事件记 `verified:"metadata"`，**不记 exact**。不再有 `rehash` 参数（原 `rehash=false` 默认与 A11 冲突，已删除）。
4. **不匹配 → 该文件失败**：作业事件/响应 `reason="PRECHECK_STALE"`，**不登记**；同一请求的其它文件照常。
4a. **预校验先于一切登记（N3）**：作业/路由在执行 `createItem`、`registerAssets`、`importBoothUrl`、任何 `items/assets/item_images/tags/categories` 写之前，必须逐文件完成：① `expected` 存在且 `size/mtime` 匹配；② `expected.sha256` 存在时重算并匹配；③ `path_norm` 归属检查（属于另一个 item → 该文件失败 `PATH_OWNED_BY_OTHER_ITEM`，不登记）。失败文件只记作业事件/响应，不产生任何行。
4b. **分组与空 item（N3）**：预校验通过的文件再按 `group`（`rootPath/rootId`）分组；某组没有任何通过文件 → 不创建 item；某组有通过文件 → 只为通过文件创建/复用 item 并登记。禁止“先 createItem 再发现全部 stale”留下空 item。
4c. **残余窗口**：预校验（stat/哈希）在 DB 事务之前；从最后一次读取到 `INSERT` 提交之间文件仍可能变化。`expected.sha256` 把窗口压到“重算 → 提交”，但不能用文件系统 API 消除；本设计不声称消除。
5. **`path_norm` 已属于另一个 item → 409 `CONFLICT`**（外层 `CONFLICT`，`details.code="PATH_OWNED_BY_OTHER_ITEM"`，`details:{itemId, assetId}`），不登记。本轮不提供“移动旧 owner”；用户可跳过，或走既有 `POST /api/items/merge`（不复制其逻辑）。同一 item 同一路径 → 现状幂等。
6. **重复路径**：按 `path_norm` 去重，保留第一次出现，响应 `duplicates: [path...]`；不重复建 job。
7. **顺序**：按数组顺序建 job（每文件一个 `import_file` job，沿用现有 job 模型）；顺序只影响排队，不影响结果。
8. **截断**：预检 `truncated=true` 时，未展示的文件不在 `files` 里，因此不会被登记；UI 不得提供“整目录导入”按钮。用户要导入剩余文件必须重新预检。
9. **旧形状兼容**：仍接受 `{paths: [...]}`（现状），行为与现在逐字节一致（目录递归、无 expected、无 pathCollision 检查）。该形状标记为 legacy，**新 UI 不得使用**；服务端在 job payload 记 `legacy:true` 便于审计。N3 的“预校验先于登记/分组不建空 item”保证只覆盖 `files` 新形状与带 `expected` 的同步路由；legacy 形状保持旧行为，不擅自改网络元数据整体业务。

`POST /api/items/:id/assets` 增加同样的可选 `expected`（单文件）：

- 传了 `expected` → **路由内同步重验**（该路由是同步的，不是 job；P3-7 措辞修正），不匹配 → 409 `PRECHECK_STALE`，不登记。
- 不传 → 现状行为。
- 该路由同样受 `pathCollision` 约束：`path_norm` 属于另一个 item → 409。

### 6.4 下载的两阶段（主 UI 默认开启）

- `POST /api/import/download` 增加可选 `stage?: boolean`。
- **主 UI 的所有下载流程固定发送 `stage=true`**；API 不传时保持现状（legacy），但新 UI 不得默认关闭（P2-9）。
- `stage=true` 的时序（N3）：
  1. 下载到临时文件 → 发布最终名（沿用现有 `link()` 独占语义）。
  2. **只读预检**：stat、按需重算 sha256、pathCollision 查询；不写 items/assets/item_images/tags/categories，不建 job，不调用 `importBoothUrl`。
  3. **元数据只读**：如带商品号，只调用 `booth.fetchItem` 取卡片元数据（标题/店铺/价格/标签/图片 URL），**不**调用 `importBoothUrl`，不建 item、不抓图、不写标签/分类。
  4. 返回 `{staged:true, stageToken, bytes, fileName, precheck, meta?}`；**不返回可回传的路径**。
- **`stageToken` 是服务端发放的不透明令牌**（P2-4）：
  - 载荷：`{v:1, p:最终路径, r:downloadRoot, i:源商品号|null, s:size, m:mtime, h:sha256, e:过期时刻, n:nonce, ep:进程 epoch}`；
  - 签名：HMAC-SHA256，密钥为进程启动时随机生成；`ep` 在每次启动变化；
  - 客户端只能回传 token 字符串，**不能回传路径**；服务端不接受任何客户端提供的 `stagedPath`。
- `POST /api/import/download/commit {stageToken, decision:"import"|"skip"}`：
  - **先查回执（P2-2）**：解析 token 得到 `n`，用 `n` 查 `import_stage_commits`（`nonce` 主键），比较 `token_hash` 与 `sha256(token)`；命中且相同 → 200 `{replayed:true, decision, itemId, assetId}`，不再登记、不再消费。回执存在但 `token_hash` 不同（nonce 碰撞/伪造）→ 409 `STAGE_TOKEN_CONSUMED`，**不得返回他人指针**。回执查询先于签名/`ep`/TTL/文件/归属检查，保证已提交 token 在响应丢失、进程重启、文件或 owner 变化后仍可重放。
  - 未命中回执 → 校验签名、`ep`、TTL 30 分钟、`p` 在 `r` 的 realpath 前缀内、`stat(p)` 的 size/mtime 仍等于 `s`/`m`、重算 sha256 等于 `h`；任一失败 → 409/410（`STAGE_TOKEN_INVALID`/`STAGE_TOKEN_EXPIRED`/`STAGE_FILE_CHANGED`）。
  - **token 验证与重算在 SQLite 事务外**；不要在 better-sqlite3 同步事务里做 async 网络/哈希。
  - **事务内重查回执（P2-4）**：`BEGIN IMMEDIATE` 取得写锁后、任何写/归属检查/回执登记之前，按 nonce 再查一次 `import_stage_commits`，用与事务外快路径相同的纯同步 replay 判定：命中且 `token_hash` 相同 → 200 指针（已提交 import 指针 NULL → 410，skip NULL → 200）；命中但 `token_hash` 不同 → 409 `STAGE_TOKEN_CONSUMED`，不返回指针；未命中才继续。事务内不得有 `await`；不得用通用 catch 掩盖真实 SQLite 错误；失败整体回滚、nonce 未消费、可重试。
  - **业务检查在事务内、登记之前（P2-1）**：进入同一 SQLite 事务后（重查回执之后），先解析目标 item（按 `(source_site, source_item_id)` 复用已有 item，或标记为“新建 item 意图”），再查 `path_norm` 归属：已存在且属于另一个 item（目标为新建意图也算“另一个”）→ 409 `PATH_OWNED_BY_OTHER_ITEM`，回滚、nonce 未消费、不建 item/asset；属于同一 item → 幂等；不存在 → 允许。该检查**不得**委托给 `upsertAsset` 的已存在分支（它会在无 version links 时静默改 owner）；stage 之后才被占用同样在此被挡。
  - **同一 SQLite 事务内**：按“重查回执（P2-4）→ 重验归属 → 以 NULL 指针 `INSERT INTO import_stage_commits(nonce, token_hash, decision, item_id, asset_id, created_at)` → 创建/复用 item → `upsertAsset` 登记 asset → `UPDATE import_stage_commits SET item_id=?, asset_id=? WHERE nonce=?`”的顺序执行（`skip` 只执行回执插入，指针保持 NULL）。回执先以 NULL 指针占住 nonce，登记成功后再在同一事务内写真实指针；不得先建 item 再插回执。任一步失败 → 整个事务回滚，nonce 未消费，文件保留，返回可重试错误（409/500）。
  - `skip`：同一事务只写 `decision='skip'` 的回执（item_id/asset_id 为 NULL），不解析目标 item、不做 path 归属检查，不建 item/asset/image/tag，不迁 owner，不写 `audit_log`；返回 `{skipped:true}`。
  - **提交后 best-effort（P3-6）**：`import` 成功后，再调用 `attachBoothMetadata(repo, media, client, itemId, meta)`（或等价的 attach-only 函数）。契约：只允许给**已存在的 item** 附加元数据/图片/标签/分类；**禁止** `createItem`、**禁止** `moveAssets`、**禁止**改 asset owner；失败只记日志，不回滚回执、不重复登记。不得直接复用会建 item/迁资产的 `importBoothUrl`。
  - **证据边界（P3-6/P3-9 撤销）**：revision-3 设计探针里的 attach/stage 写钩子未接线、无辨别力（review-r3 的副本 mutation test 已证明）；本设计**不把“钩子 0 次”当证据**，只保留文字契约。stage 只读与 attach-only 的写隔离必须在实施期用真实 mutation 测试在产品级验证；本设计不声称已证明。
  - **重放（P2-2）**：同一 token 第二次 commit → 回执命中 → 200 返回指针（不再登记）；若回执不存在但 nonce 已被别的 token 占用 → 409 `STAGE_TOKEN_CONSUMED`。
  - **回执指针失联（P3-7）**：已提交 `import` 回执的 `item_id`/`asset_id` 因硬删被 `ON DELETE SET NULL` 置空 → 重放返回 410 `STAGE_COMMITTED_OBJECT_DELETED`，标记“已提交对象已删除”，**不重建**、不重复登记；`decision='skip'` 的空指针仍返回 200 `{replayed:true, decision:'skip'}`。
  - **重启语义**：secret/epoch 在进程启动时变化 → 未提交的旧 token 签名/epoch 失效（410 `STAGE_TOKEN_INVALID`）；已提交的 token 因回执先查，仍返回指针。已下载文件保留在磁盘，用户可重新预检或重新下载。
- 不传 `stage` 时行为与现状逐字节一致（legacy）。

## 7. 导入路径处理点

| 处理点 | 入口 | 预检时机 | 跳过时 | 备注 |
|---|---|---|---|---|
| P1 本地文件/目录 | `POST /api/import/paths` → `import_file` 作业（`apps/server/src/jobs/runner.ts:166`） | UI 先调 `/api/import/precheck`；作业只处理 `files` 列表，逐文件按 `expected` 重验 | 不登记；文件留在原处 | 目录只在预检展开，最多 500 文件；执行不递归 |
| P2 手动挂载 | `POST /api/items/:id/assets`（`routes.ts:386`） | 同上；路由内同步重验 | 不登记；文件留在原处 | 只新增 asset，不改旧 asset 归属；pathCollision → 409 |
| P3 下载到临时再入库 | `POST /api/import/download`（`routes.ts:1734`） | `stage=true`（主 UI 默认）时下载后、入库前 | 不登记；**不自动删除**已下载文件 | token 绑定路径/商品/size/mtime/hash；commit 重验 pathCollision；回执重放优先；重启失效 |

### 7.1 TOCTOU 与过期凭据

- 预检返回 `size/mtime/sha256/checkedAt`；导入时按 `expected` 重验。
- `expected.sha256` 存在 → 强制重算并比对；不存在 → 只比 size+mtime，作业事件标 `verified:"metadata"`。**size+mtime 相等不等于内容绝对没变**（保持时间戳的改写就是反例），这是已知残余窗口；要更强保证就带 `sha256`。
- 即使带 `sha256`，从“最后一次读取”到“INSERT 提交”之间仍有窗口；本设计不声称消除它。
- 下载 URL 可能过期：下载失败按现有 HTTP 错误处理；预检不使用凭据。
- 元数据抓取（BOOTH JSON）可能因 cookie 过期失败：**元数据失败不等于“没有重复”**；预检只读本地文件与库，不依赖元数据；入库仍按现有 best-effort 逻辑继续。
- 库内哈希可能陈旧：按 §3.1 的 stat + 重算判定，不用 `last_verified_at`。

### 7.2 预算、取消、降级

- 总字节预算默认 4 GiB、总时间默认 20 s；单文件上限 2 GiB。超预算的剩余文件 `unknown(reason="budget_exceeded")`，`truncated=true`。
- 候选重算也计入同一预算；预算不足 → `existing_hash_unverified`，不 exact。
- 取消：HTTP 断开或 `AbortSignal` → `sha256FileChunked` 抛 `CANCELLED`/`TIMEOUT`，映射为 `unknown`；不写任何行。
- **不以名称/尺寸降级为 exact**：最多 `weak.name_size_hint`，UI 必须显示“不是精确重复”。

### 7.3 跳过与临时文件

- 跳过 = 不提交该文件到导入端点；服务端不建 item/asset/job/scan_preview 行。
- 下载 `stage=true` 后跳过：文件保留在最终路径；**不自动删除**。清理是显式动作（用户手动删除，或未来的显式清理入口）。
- 下载被取消（网络中断/用户取消）：临时文件删除，不发布最终名，不建 item/asset。
- 预检本身不产生临时文件；哈希是流式读。

## 8. UI 设计

### 8.1 入口与文案

- `ImportPanel`（`apps/web/src/components/ImportPanel.tsx`）在“本地路径导入”与“拖拽导入”之间加“预检”按钮；点击后展示结果卡。
- 结果卡按文件一行，标签：
  - `精确重复（字节相同）` — 显示已有条目/资产路径；
  - `同商品，可能是新版本（未证实）` — 显示双方版本键与“需人工确认”；
  - `同商品，可能是配套文件（未证实）` — 显示命中标记；
  - `同商品` — 只提示身份；
  - `路径已属于 #X《title》` — pathCollision；按钮“跳过”/“去合并条目…”（跳既有合并入口，不新增移动动作）；
  - `弱提示：同名同尺寸（不是精确重复）`；
  - `未知（哈希失败/超预算/已取消）`。
- 按钮：`跳过（不登记）`、`仍然导入`、`关联到已有条目…`、`标记版本关系…`。
- “仍然导入”提交的是**当前勾选的文件列表**（每项带 expected），不是原目录。
- 文案禁止：“已验证版本”“确认是新版本”“实时磁盘检查”。统一用“候选版本关系（需确认）”。

### 8.2 版本关系面板

- `ItemDetail` 增加“版本关系”区：列出候选/已确认/已撤销；每条显示两个 asset 的文件名、版本键、依据、状态；按钮“确认”“更正…”“撤销”“删除记录”。
- 确认/更正/撤销都带 `expectedVersion`；409 时提示“已被其他操作修改，请刷新”。

### 8.3 下载流程（主 UI）

1. 用户点下载 → 主 UI 发送 `stage=true`。
2. 下载中可取消：取消 → 临时文件删除，无 item/asset。
3. 下载完成 → 展示预检卡（exact / sameProduct / version / companion / pathCollision / weak / unknown）。
4. 元数据（BOOTH JSON）抓取失败：卡片显示“元数据未取到，不影响文件与预检”，不阻断。
5. 用户选择“导入”或“跳过” → 调 commit（带 `stageToken`）。
6. 跳过 → 文件保留，提示“文件已保留在下载目录，未登记”。

## 9. 并发、事务、一致性

### 9.1 资产归属变更的共享检查与共享事务（P2-1 / N2）

- 新增服务层函数 `assertAssetOwnerChange(repo, assetId, newItemId, ctx)`：
  - `existing.item_id === newItemId` → 通过；
  - 该 asset 有 `asset_version_links` 行且 `ctx.merge !== true` → 抛 `CONFLICT`（409，`details.code="ASSET_HAS_VERSION_LINKS"`）；
  - 否则通过。
- 新增内部同步事务 `moveAssetsAndVersionLinksTx(fromItemId, toItemId, ctx)`：
  1. 对 from 的每个 asset 调 `assertAssetOwnerChange(..., ctx)`；
  2. `UPDATE assets SET item_id=to WHERE item_id=from`；
  3. `UPDATE asset_version_links SET item_id=to, updated_at=? WHERE item_id=from`；
  4. 事务末断言 0 行不一致（下方 SQL）。
- **所有官方 owner 变更调用点**：

| 调用点 | 入口 | 处理 |
|---|---|---|
| `upsertAsset` 已存在分支 | `repo.ts:402-415`；`scan.ts:400`（registerAssets）、`routes.ts:399`（手动挂载）、`routes.ts:1763`（下载） | `ctx.merge=false`；带关系且换 owner → 409 `ASSET_HAS_VERSION_LINKS`；同 item 幂等 |
| `registerAssets` | `scan.ts:396` | 经 `upsertAsset`；scan 批次逐文件捕获冲突，跳过该文件 + 事件，不失败整批（下方） |
| `moveAssets` | `repo.ts:657`；`booth.ts:109`（link-booth merge） | 改为调用共享事务，`ctx.merge=true`；迁 assets + version links；保留 link-booth 原有“移资产 + 软删本地 item”语义，不迁 loadout/ignore |
| `mergeItems` | `repo.ts:576-654`；`routes.ts:1318` | 调用共享事务，`ctx.merge=true`；随后继续原有图片/标签/导入登记/分类/软删语义；loadout_items/cleanup_ignores 迁移仍由 mergeItems 负责 |

- **link-booth 的语义边界（N2）**：`POST /api/items/:id/link-booth {merge:true}` 不改成全量 `mergeItems`；只把 `moveAssets` 替换为共享事务，使 `asset_version_links` 随资产迁移。它仍只移资产、软删本地 item，不迁 loadout_items/cleanup_ignores，不复制 mergeItems 的图片/标签/分类逻辑。这样既覆盖官方 owner 路径，又不改变旧产品行为。
- **scan 批次文件级跳过（N2）**：`registerBatch` 在 `createItem` 前逐文件预检 owner 冲突；若某文件的目标 item 与现有 asset 的 owner 不同且该 asset 有 version links → 跳过该文件 + `logJobEvent("asset_owner_conflict_skipped", ...)`，不创建空 item；同批其它文件继续。若整组都冲突 → 不建 item。
- `mergeItems` 在事务末断言：

```sql
SELECT COUNT(*) FROM asset_version_links l
JOIN assets a ON a.id = l.asset_a_id
JOIN assets b ON b.id = l.asset_b_id
WHERE l.item_id <> a.item_id OR l.item_id <> b.item_id
```

  必须为 0，否则抛错回滚。
- **保证边界（明说）**：这是应用层保证 + 事务末断言。任意 SQL（sqlite3 CLI、未来新增的写路径、绕过 repo 的脚本）**不受保护**；库层只有 §5.2 的关系侧触发器。若未来要库层强保证，需要 `assets(item_id,id)` 唯一索引或 deferred 约束，属于冻结表变更，需单独批准。
- **`asset_units.item_id` 不在本共享事务范围（P3-10）**：`replaceAssetUnits`（`repo.ts:2195`）会写 `asset_units.item_id`，但它是既有 denormalization，不是 `assets.item_id` 的 owner 变更；资产换 owner 后该列可能陈旧。本轮只列边界，不修旧功能；若未来要用它做 owner 过滤，需单独设计。

### 9.2 预检与版本关系

- 预检是只读快照：并发导入可能让结果在返回时已过期；UI 必须把结果当“检查时刻的快照”，导入时按 `expected` 重验。
- 版本关系 mutation 用 `db.transaction` + `UPDATE … WHERE id=? AND version=?` 的 CAS；0 行 → 409。**不声称线程安全**：实际保证是单进程 + better-sqlite3 同步执行 + SQLite WAL + `busy_timeout=5000`；跨进程并发不在保证范围。
- 审计：确认/更正/撤销/删除都写 `audit_log`（`repo.ts:1349`），与业务更新同事务。

## 10. 生命周期与清理

| 事件 | 对 `asset_version_links` 的影响 |
|---|---|
| item 软删（`status='trashed'`，`routes.ts:341`） | 关系保留；`GET` 仍返回；UI 默认折叠并标“回收站” |
| item 恢复（普通回收站恢复） | 关系原样可见（关系从未离开该 item） |
| `mergeItems(source→target)`（`repo.ts:576`） | **同一事务内**：① `UPDATE assets SET item_id=target WHERE item_id=source`（`ctx.merge=true`）；② `UPDATE asset_version_links SET item_id=target, updated_at=? WHERE item_id=source`；③ 事务末断言（§9.1）；④ 审计 `merge.version_links_moved`（计数）。**保留 `id`/`state`/`version`/`created_at`/`decided_at`**。 |
| 合并后恢复 source | **不恢复关系**：关系已属于 target。source 恢复后是一个没有资产、没有关系、没有图片的空条目；UI 必须提示“该条目已合并到 #N，恢复不会带回资产与关系”（P3-6） |
| asset 硬删 | `ON DELETE CASCADE` 删除相关关系 |
| item 硬删（当前无产品入口） | `ON DELETE CASCADE` 删除关系；若未来加永久删除入口，UI 必须提示“该条目有 N 条版本关系” |

**为什么合并用 `UPDATE` 而不是 `INSERT OR IGNORE + DELETE`（P1-1）**：

- `UNIQUE(asset_a_id, asset_b_id)` 是全局唯一。合并第 ① 步之后，源行仍占着 `(a1,a2)`；第 ② 步若 `INSERT OR IGNORE` 到 target，会被唯一约束 IGNORE；随后 `DELETE … WHERE item_id=source` 删掉唯一一行 → 关系丢失（review 探针 T13a 可复现）。
- `UPDATE` 直接改 `item_id`：此时两个 asset 都已属于 target，触发器通过；全局唯一约束不受影响（同一对 asset 仍只有一行）。
- `INSERT OR IGNORE + DELETE` 只保留给 `loadout_items`（PK 是 `(loadout_id,item_id)`）和 `cleanup_ignores`（PK 是 `(item_id,rule)`）：这两张表的 target 行**可能已经存在**，才需要“保留 target、删 source”的冲突规则。

## 11. 验收（可执行的正反例）

> 全部用临时 fixture 文件（已知字节）与临时 DB，不依赖真实素材库/生产库。

| # | 场景 | 期望 |
|---|---|---|
| A1 | 两个文件字节完全相同，库中已有其一（磁盘未变） | `exact` 非空，`rehashVerified=true`；预检前后 items/assets/asset_signatures 行数不变 |
| A2 | 同商品、不同字节、双方版本键可解析（1.2 vs 1.3） | `sameProduct` 非空；`version.relation="newer"`、`proven=false`；**不是 exact** |
| A3 | 字节相同但商品号不同 | `exact` 非空；`sameProduct=null`；不得声称同商品 |
| A4 | 同名同尺寸但字节不同 | `exact=null`；最多 `weak.name_size_hint`；不得 exact |
| A5 | 同商品、任一方版本键不可解析（如 `2025.zip`） | `version.relation="unknown"`；不猜 newer/older |
| A6 | 文件超过单文件上限 | `hash.state="unknown"`、`reason="too_large"`；不 exact |
| A7 | 总预算耗尽 | 剩余 `unknown(budget_exceeded)`、`truncated=true`；不 exact |
| A8 | 客户端取消 | `unknown(cancelled)`；无任何写 |
| A9a | 库中候选 `sha256_state='ok'`，但磁盘 `mtime` 与库内 `mtime` 不一致 | 不 exact；`weak.reason="existing_hash_stale"` |
| A9b | 磁盘 size/mtime 与库内一致，但内容已变（保持时间戳） | 不 exact；`weak.reason="existing_hash_mismatch"` |
| A9c | 候选重算因预算未执行 | 不 exact；`weak.reason="existing_hash_unverified"` |
| A10 | 用户跳过 | 不建 item/asset/job/scan_preview；文件仍在 |
| A11 | 导入时 `expected.sha256` 不匹配（内容变、时间戳保留） | 该路径失败 `PRECHECK_STALE`；不登记；其余路径照常 |
| A11b | 导入时只带 size/mtime 且不匹配 | 该路径失败 `PRECHECK_STALE`；作业事件 `verified:"metadata"`；不登记 |
| A11c | `files` 新形状，组内全部 stale | 不创建 item；不登记任何 asset；无空 item；其它组照常 |
| A11d | `files` 新形状，组内部分 stale | 只为通过文件创建/复用 item 并登记；stale 文件不登记；无空 item |
| A12 | 版本关系确认/更正/撤销 | 落库；`version` 递增；`audit_log` 有对应行；重启后仍在 |
| A13 | 并发 PATCH 同一关系（旧 `expectedVersion`） | 后者 409 CONFLICT；不覆盖前者 |
| A14 | 同商品导入第二个文件 | 复用同一 item（`source_item_id` 唯一索引不冲突）；旧 asset 保留 |
| A15 | 预检调用 `mergeItems`/写库函数 | 静态检查/测试断言不调用；预检前后 DB 行数不变 |
| A16 | 跨 item 建版本关系 | 400 INVALID_INPUT（或触发器 ABORT 映射为 400）；不落行 |
| A17 | 预检一个 `path_norm` 已属于 item X 的文件 | `pathCollision={itemId:X, sameItem:false}`；导入 → 409 `PATH_OWNED_BY_OTHER_ITEM`；不登记；X 的 asset 归属不变 |
| A18 | 目录 A/B/C，预检后跳过 B，提交 A、C | 只登记 A、C；B 不登记；B 文件仍在 |
| A19 | 预检 `truncated=true`（>500） | 未展示文件不在 `files`；提交后不登记；UI 无“整目录导入” |
| A20 | 预检后目录新增 D，提交 A、C | D 不登记（执行不递归） |
| A21 | `files` 含重复路径 | 去重；`duplicates` 列出；只建一个 job |
| A22 | `files` 顺序 C、A | job 按 C、A 顺序创建；结果与顺序无关 |
| A23 | `files` 里某项是目录 | 400 `DIRECTORY_NOT_ALLOWED_WITH_FILES`；不建 job |
| A24 | `files` 里某项缺 `expected` | 400 `EXPECTED_REQUIRED`；不建 job |
| A25 | 合并 source→target，source 有 2 条关系 | 关系行数不变；`item_id=target`；`id`/`state`/`version` 保留；事务末断言通过 |
| A26 | 合并后恢复 source | source 无资产、无关系；UI 提示“恢复不会带回资产与关系” |
| A27 | 直接改带关系 asset 的 `item_id`（非 merge） | 409 `ASSET_HAS_VERSION_LINKS`；关系不变 |
| A27b | link-booth merge（`POST /api/items/:id/link-booth {merge:true}`） | 资产与 `asset_version_links` 同事务迁到 BOOTH owner；关系行数不变、`item_id=owner`；本地 item 软删；loadout/ignore 不变 |
| A27c | scan 批次中一个文件带关系冲突 | 该文件跳过 + `asset_owner_conflict_skipped` 事件；整批不失败；其它文件登记；不建空 item |
| A28 | 合并事务中途断言失败（人为构造） | 整个事务回滚；资产与关系都回到合并前 |
| A29 | `revoked` 关系再 PATCH 为 `confirmed` | 允许；`version+1`；`decided_at` 更新；审计有行 |
| A29b | `confirmed` 关系 PATCH 为 `candidate` | 允许；`version+1`；`candidate` 是人工声明，不把 `proven` 设为 true；审计有行 |
| A29c | `revoked` 关系 PATCH 为 `candidate` | 允许；`version+1`；审计有行 |
| A30 | 同状态 PATCH（confirmed→confirmed） | 幂等 no-op；`version` 不变；不写审计 |
| A31 | commit 传任意路径而非 token | 400 `INVALID_INPUT`；不登记 |
| A32 | commit 重放同一 token（已提交 import） | 第二次 200 `{replayed:true, decision:"import", itemId, assetId}`；不重复登记；文件仍在 |
| A32b | 同一 nonce、不同 token_hash（碰撞/伪造） | 409 `STAGE_TOKEN_CONSUMED`；不返回他人指针；不登记 |
| A33 | commit 时文件被替换（size/mtime/hash 变） | 409 `STAGE_FILE_CHANGED`；不登记 |
| A34 | 服务重启后 commit 旧 token（未提交） | 410 `STAGE_TOKEN_INVALID`；文件仍在 |
| A35 | `stage=true` 下载完成 | 只建临时/最终文件；不建 item/asset/image/tag；只读 `fetchItem` 元数据；返回 token + precheck |
| A36 | `stage=true` 后 skip | 只写 `decision='skip'` 回执；不建 item/asset/image/tag；不写 `audit_log`；文件保留 |
| A37 | commit import 成功后重放同一 token | 回执命中；返回 `{replayed:true, itemId, assetId}`；不重复建 item/asset |
| A38 | commit 入库阶段 asset 插入失败（fault injection） | 整个事务回滚；nonce 未消费；item/asset 不落库；可重试 |
| A39 | commit 回执插入失败（fault injection） | 整个事务回滚；item/asset 不落库；nonce 未消费；可重试 |
| A40 | commit 成功、提交后元数据/图集附加失败 | 回执与 item/asset 保留；不重复登记；重放返回指针；只记日志 |
| A41 | 重启后重放已提交 token | 回执先查 → 返回指针；不重复登记 |
| A42 | 并发两个 commit 同一 token | 一个事务成功；另一个在 `BEGIN IMMEDIATE` 后重查回执命中，返回 200 指针；不重复建行 |
| A42b | 同一 nonce、不同 token_hash（顺序或并发） | 409 `STAGE_TOKEN_CONSUMED`；不返回他人指针；不登记 |
| A42c | 事务内重查回执先于任何写/归属检查 | 同 token_hash → 200 指针；异 → 409；事务内无 `await`；失败整体回滚、nonce 未消费、可重试 |
| A43 | stage 后、commit 前 `path_norm` 被另一个 item 占用（原负例 owner 1→2） | commit 409 `PATH_OWNED_BY_OTHER_ITEM`；asset owner 保持 1；不建新 item、不写回执；nonce 未消费，可重试 |
| A43b | commit 时 `path_norm` 已属于同一目标 item | 幂等：更新 size/mtime，不新增 asset 行；不 409 |
| A43c | commit 时 `path_norm` 不存在（unowned） | 正常登记；新建/复用目标 item；写回执 |
| A43d | 已提交回执后文件被改/owner 变化，再重放同一 token | 回执先查 → 200 指针；不因文件/owner 变化变成新提交；不重复登记 |
| A44 | 已提交 import 回执的 item/asset 被硬删（指针 NULL） | 重放 410 `STAGE_COMMITTED_OBJECT_DELETED`；标记已提交对象已删除；不重建 |
| A44b | 已提交 skip 回执（指针 NULL）重放 | 200 `{replayed:true, decision:"skip"}`；不建 item/asset |
| A45 | 提交后 attachBoothMetadata 尝试 createItem/moveAssets（fault injection） | 被契约禁止/不调用；回执与 item/asset 保留；只记日志；重放返回指针 |

## 12. 兼容性与冻结面

- 不改 `packages/core/src/contracts.ts` 的外层枚举：不新增 `JobKind`/`JobState`/`AppErrorCode`；预检不是 job。
- **错误子码（P3-5）**：`PATH_OWNED_BY_OTHER_ITEM`、`EXPECTED_REQUIRED`、`DIRECTORY_NOT_ALLOWED_WITH_FILES`、`STAGE_TOKEN_*`、`ASSET_HAS_VERSION_LINKS`、`LOCAL_POLICY_REQUIRED` 等**不新增外层 `AppErrorCode`**；外层 `code` 仍用现有 `NOT_FOUND/INVALID_INPUT/CONFLICT` 等，子码放在 additive 可选 `details.code`（响应 `{error:{code,message,details?:{code}}}`）。若实现需要给 `AppError` 增加可选 `details` 字段，这是 `contracts.ts` 的 additive 变更，列入限定冻结面，需批准；本设计只写形状，不改 type。
- 不改 `planHash` 口径与 `PreviewChange` 枚举（`scanpreview.ts:189-192`、`:24`）；预检是独立端点，不写 `scan_preview_*`。
- 不改 `docs/api.md` 既有响应形状；新增端点与可选字段是 additive。
- **冻结面要动**：新表与触发器要写进 `apps/server/src/db/schema.sql`，`migrate.ts` 要 bump `SCHEMA_VERSION`。这两个文件是 `docs/CONTRACT.md:5-8` 冻结的；本设计**不声称**“不用动冻结面”，只声称“既有表/既有 API 形状保持原样，新增是 additive，需批准后由迁移 owner 落地”。
- 不改 `mergeItems` 的既有语义；只增加版本关系的 `item_id` 重指与事务末断言（需批准）。
- 无新依赖：只用 `node:crypto`、`node:fs`、现有 core 纯函数、better-sqlite3。

## 13. 已裁定与待用户审阅的语义选择

### 13.1 已裁定（父/用户已定，不再问）

| # | 选择 | 结论 |
|---|---|---|
| D1 | 下载 `stage=true` 是否默认 | **主 UI 全部默认开启**；API 不传保持 legacy，但新 UI 不得关闭（P2-9 裁定） |
| D3 | exact 是否要求哈希新鲜 | **是**，且判据改为“stat 一致 + 本次重算相等”（P1-3 裁定） |
| D4 | 版本关系是否只做同一 item 内 | **是**（资产级） |
| D5 | 版本关系删除是软撤销还是硬删 | **软撤销 + 可选硬删候选** |
| — | 合并关系迁移方式 | **UPDATE `item_id`**，不 INSERT OR IGNORE（P1-1 裁定） |
| — | 资产归属变更保护 | 应用层共享检查 + 事务末断言；不声称任意 SQL 有保证（P2-1 裁定） |
| — | link-booth merge 的 owner 迁移 | 复用共享事务迁 assets + version links；不改成全量 mergeItems，保留旧语义（N2 裁定） |
| — | 预校验时序 | expected/哈希/pathCollision 先于 createItem/registerAssets/importBoothUrl；组内全拒不建空 item（N3 裁定） |
| — | stage commit 原子性 | token 验证/重算在外；nonce 消费 + item/asset 登记同 SQLite 事务；回执表重放返回指针（N4 裁定） |
| — | commit 归属重验 | 同一事务、登记前重验 `path_norm`；占用 → 409，不借 `upsertAsset` 改 owner；回执重放优先（P2-1 裁定） |
| — | 重放语义 | 同 token → 200 指针；同 nonce 异 token → 409；已提交指针 NULL → 410（P2-2 裁定） |
| — | commit 并发重查 | `BEGIN IMMEDIATE` 后、任何写之前按 nonce 重查回执；同 token 200 指针、异 token 409；事务内无 await（P2-4 裁定） |
| — | PATCH 版本关系 state | 允许 `candidate|confirmed|revoked`，与转移表一致；candidate 是人工声明，不冒充 proven（P3-5 裁定） |

### 13.2 仍待用户审阅

| # | 选择 | 推荐默认 | 备选 | 影响 |
|---|---|---|---|---|
| D2 | 跳过决策是否写审计 | 否（纯客户端跳过） | 是（新增 skip 审计端点） | 写审计会多一个 mutation 端点 |

## 14. 明确不做

- 不做自动合并、自动跳过、自动改归属。
- 不做“移动旧 owner”新动作（pathCollision 只提示 + 409；合并走既有入口）。
- 不做后台预检作业、不做批量预检队列。
- 不做 AI/云/自动 Unity/后台扫描引擎。
- 不把 `parseVersionKey` 或文件名当版本证明。
- 不复制 `mergeItems` 逻辑；link-booth 只复用共享的“迁资产 + 迁版本关系”事务，不改成全量 merge。
- 不把 async 网络/哈希塞进 better-sqlite3 同步事务；token 验证/重算在事务外。
- 不依赖真实生产样本做验收。

## 15. 事实与建议索引

- 事实：§2 表；§3 口径引用的 `file:line`。
- 建议：§5 DDL、§6 端点、§7 处理点、§8 UI、§11 验收；均未执行。
