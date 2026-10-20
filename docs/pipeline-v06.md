# v0.6.1 · 后台索引流水线、超大压缩包解析与缓存

> 目标：把「发现 → 建档 → 深度解析」解耦，让一个 2GB 的压缩包不再堵住整个扫描队列；
> 所有资源消耗有明确上限，任务可取消、可重试、崩溃后可恢复、失败可诊断。
>
> 本文是实现说明（不是提案）：所有默认值、状态、表结构都与代码一致
> （`apps/server/src/services/pipeline/*`、`apps/server/src/jobs/runner.ts`、`apps/server/src/db/schema.sql`）。
>
> v0.6.0 建起流水线本体；**v0.6.1 做的是加固**：发现层有界化（§4.1）、jobs 租约与围栏（§3.1）、
> 缓存身份收紧（§5.1）、事件保留（§9.1），外加一轮去掉固定开销的性能优化（§10）。schema 5 → 6。

---

## 1. 一句话架构

```
HTTP / 收件箱 / 扫描预览
        │
        ▼
  jobs（顶层作业，13 态 CAS）
        │  只做：发现 → 基础建档 → 入队 → 有界等待
        ▼
  index_tasks（每个资产 × 每个阶段一条）
        │  queued → running → done | skipped | waiting_retry | failed | cancelled
        ▼
  IndexPipeline（7 类 worker，各自并发上限，DB CAS 领取）
        │
        ├─ hash           流式 sha256（常量内存、可取消、带进度）
        ├─ archive        zip/7z/rar 目录（缓存 + 限制 + 早期停止）
        ├─ unitypackage   gzip+tar 结构（缓存 + 早停）
        ├─ thumbs         图片抽取 / 解码 / WebP（像素上限、失败保留旧封面）
        ├─ meta           结构/GUID/文件哈希三路去重签名
        ├─ categorize     avatar 匹配 + 自动分类建议（手选永不被覆盖）
        └─ fts            FTS5 同步
```

**没有第二套作业状态机**：`jobs` 仍是顶层生命周期；`index_tasks` 是它派生的子任务队列。
扫描 / 应用 / 导入作业在 `indexing` 阶段只负责入队（可配置短等待），随后照常走
`index_ok → matching → releasing_done → done`。

`jobs` 的跨进程一致性由**租约 + fencing token** 保证（v0.6.1，见 §3.1）；`index_tasks` 靠
唯一活跃索引 + DB CAS 领取。两者都不用内存队列。

---

## 2. 阶段与依赖

| 阶段 | 适用 | 依赖 | 并发默认 | 失败语义 |
|---|---|---|---|---|
| `hash` | 所有资产 | — | 2 | 重试 3 次；文件消失 → skip |
| `archive` | zip / 7z / rar | — | 1 | 坏包 → 重试后 failed；超限 → skipped(BYTES/ENTRIES/RATIO) |
| `unitypackage` | .unitypackage | — | 1 | 坏 gzip/tar → failed；超限 → skipped |
| `thumbs` | 上面两类 | archive / unitypackage | 2 | 单图失败只计数；全失败 → skipped(UNSUPPORTED) |
| `meta` | 所有资产 | 前一个阶段 | 1 | 签名失败只记日志，不阻塞 |
| `categorize` | 所有资产 | meta | 1 | 单条失败不影响作业 |
| `fts` | 所有资产 | categorize | 1 | 失败可重试 |

依赖通过 `index_tasks.depends_on` 显式表达（领取条件：依赖任务 `done` 或 `skipped`）。
上游永久失败时，直接下游会被标 `skipped(UPSTREAM_FAILED)`，不会留下永远 queued 的"假等待"。

**为什么 hash 不挂在 archive 后面**：哈希和解包是两类资源（顺序 IO vs CPU/解压），
分开可以并行，也避免"先算完 8GB 哈希才开始列目录"。代价是首轮 archive 往往只有弱身份
（size+mtime），缓存键会从 weak 迁移到 sha256（见 §5）。

---

## 3. 任务状态与进度

```
queued ──claim──▶ running ──ok──▶ done
   ▲                  │
   │                  ├─不适用/超限──▶ skipped (error_code = NOT_APPLICABLE / BYTES / ENTRIES / PIXELS / RATIO / UPSTREAM_FAILED / STALE / ASSET_GONE)
   │                  ├─可重试失败──▶ waiting_retry (指数退避，attempts+1)
   │                  └─不可重试/次数用尽──▶ failed
   └──── retry（人工：requeueIndexTask，attempts 归零）──────┘
```

- `attempts` 在 **claim 时** +1，因此"执行到一半崩溃"也会计数，不会无限重试。
- 退避：`min(retryMaxMs, retryBaseMs * 2^(attempts-1))`。
- 进度字段：`bytes_done/bytes_total/items_done/items_total`，默认每 `progressFlushMs`（400ms）
  落一次库；**不伪造百分比**——总量未知时只展示已处理数量与阶段。
- 资产级汇总：`assets.index_state` = pending / queued / running / done / failed / limited，
  `assets.index_error` 保留首个失败原因。

### 3.1 jobs 租约与围栏（v0.6.1）

`index_tasks` 是资产级子任务；`jobs` 才是顶层生命周期。v0.6.1 起它的唯一性不靠"进程自己保证"，
而是靠数据库里的**租约 + fencing token**：

| 列 | 值 | 含义 |
|---|---|---|
| `holder` | `host#pid#rand` | 实例身份（同机多进程也能区分） |
| `lease_until` | ISO UTC | 租约到期；`NULL` = v5 遗留的无主行，按过期处理 |
| `lease_token` | 整数，领取/接管时 +1 | **fencing**：旧持有者的迟到写入按它被 CAS 拒绝 |
| `heartbeat_at` | ISO UTC | 最近一次续租（诊断"这任务还活着吗"） |

领取是一次原子 UPDATE：`state='resolving', started_at, attempts+1, holder, lease_until, heartbeat_at,
lease_token=lease_token+1`（`WHERE id=? AND state=?`）；续租是
`WHERE id=? AND holder=? AND lease_token=?` —— **续不上就说明已经被接管**。

- **TTL / 心跳 = 60s / 15s**（`ASSETVAULT_JOB_LEASE_MS` / `ASSETVAULT_JOB_HEARTBEAT_MS` 可覆盖）。
- **过期接管**：`reapExpiredLeases()` 只捞 `lease_until` 已过期的在飞作业（含 `releasing`），
  接管时 `lease_token+1`。秒级心跳在续租，所以正在跑的那一份**不会过期**——接管不影响活任务；
  本进程自己的行另有 `protectHolder` 显式排除，挡住"SELECT 之后自己刚续租"的窗口。
- **旧持有者**：`runJob` 内的每次状态转移与诊断事件都带 `(holder, lease_token)` 条件；
  CAS 不中抛 `LeaseLostError`（HTTP 409 `LEASE_LOST`）**且不写事件**（事件围栏失配时静默丢弃、返回 false）。
  因此过期进程不可能把新持有者的状态覆盖回去。
  用户经 HTTP 发起的 pause/cancel/retry **不带租约**（按 state 做普通 CAS），行为与旧版一致——
  否则"暂停一个正在跑的作业"会变成"必须先证明自己是持有者"，而用户本来就不是。
- **释放**：到 `paused` / 终态时清空 `holder`、`lease_until`，但**保留 `lease_token`**，继续围栏旧持有者。
- **毒作业保护**沿用 §6：同一作业被恢复 ≥3 次 → `failed` + `abandoned_after_recoveries` 事件。
- **启动条件**：runner 只在**取得 `data/pipeline.lock`** 时才启动（`server.ts`：`if (lock.acquired) runner.start(400)`）；
  没抢到锁的实例只提供 HTTP，作业留在库里排队。文件锁管"两个实例别同时跑"，租约管"跑着跑着进程没了 / 卡死了"。

---

## 4. 资源限制（默认值 = 安全优先）

全部可在 `settings.pipeline_limits`（JSON）覆盖；读取时逐项 clamp（`resolveLimits`）。
修改后需重启（LIMITS 在启动时固化，并参与缓存键）。

| 键 | 默认 | 含义 |
|---|---|---|
| `hashConcurrency` / `archiveConcurrency` / `unityPackageConcurrency` / `thumbConcurrency` / `metaConcurrency` / `categorizeConcurrency` / `ftsConcurrency` | 2 / 1 / 1 / 2 / 1 / 1 / 1 | 分类并发上限（不拿 CPU 核数当万能并发） |
| `registerBatchSize` | 200 | 发现/登记批大小（事务粒度） |
| `maxScanFiles` / `scanMaxDepth` / `scanDeepMaxDepth` | 20000 / 6 / 10 | 发现上限 |
| `hashChunkBytes` | 1 MiB | 哈希读块 |
| `maxHashBytes` | 8 GiB | 超过则不哈希（标 limited，保留记录） |
| `maxArchiveBytes` | 4 GiB | 超过不解析目录 |
| `maxArchiveEntries` | 20000 | 单包条目上限（超出 truncated + limited=ENTRIES） |
| `maxEntryBytes` | 64 MiB | 单条目读取上限 |
| `maxTotalReadBytes` | 512 MiB | 单资产累计读取上限（早停） |
| `maxNestedDepth` | 1 | 嵌套包展开层数 |
| `maxNestedBytes` | 256 MiB | 嵌套包大小上限 |
| `maxUnityPackageAssets` | 20000 | unitypackage 资产条目上限 |
| `maxCompressionRatio` | 200 | 解压比上限（高压缩比只标记，不静默解压） |
| `maxImageBytes` / `maxImagePixels` / `thumbMaxSize` / `maxThumbsPerAsset` | 12 MiB / 40MP / 512 / 8 | 图片与缩略图 |
| `hashTimeoutMs` / `archiveTimeoutMs` / `thumbTimeoutMs` | 10min / 10min / 2min | 单任务超时（超时 abort + 失败/重试） |
| `taskMaxAttempts` / `retryBaseMs` / `retryMaxMs` | 3 / 1s / 60s | 重试 |
| `queueHighWater` / `queueLowWater` | 2000 / 500 | 背压水位（入队方据此暂缓，**满不等于失败**） |
| `cacheMaxBytes` / `cacheMaxAgeDays` / `cacheKeepEntries` | 2 GiB / 30 天 / 100 | 缓存淘汰 |

**降级而不是假装成功**：超限任务写 `skipped + error_code`，资产仍是 `limited`；
调大限制后对资产重新入队即可，不需要删库。

### 4.1 发现背压与有界发现（v0.6.1）

扫描曾经是"先把整棵树的候选收进 `filesOut`，再一次性登记"——2 万上限内还好，10 万文件就是几百 MB
路径常驻 JS 堆，且深度索引入队深度不受控。v0.6.1 改成**流式批处理 + 数据库清单**：

- **流式遍历**：`walkCandidates(dir, { batchSize, limit, manifest, signal, onBatch })` 逐批回调；
  **传入 `onBatch` 时 `filesOut` 恒为空数组**（不是"用完后清空"，是从不累积）。
- **清单表 `scan_seen(path_norm PK)`** 是 **TEMP 表**（免迁移、随连接消失）。只在 `onBatch`
  **成功返回后**按批写入；未提交/中止批次不记——重放会重新看到它们。
- **判缺用 SQL**：库里 present、但 `NOT EXISTS (SELECT 1 FROM scan_seen …)` 的才算"本轮没见到"。
  路径前缀走**范围查询**（`[prefix+"/", prefix+"0")`）而不是 `LIKE`，直接吃 `path_norm` 索引。
  `missingWriteGate` 仍照旧把关：截断/不可读的一轮不写 missing。
- **入队也按批**：`scan_assets(asset_id PK)` TEMP 表记"本轮入队的资产"，后续有界 drain 读它，
  不再把 `assetIds` 数组留在内存。
- **背压闸门**：每批登记前看 `countQueuedScanAssets()`（只统计**本轮**资产的 queued，
  不会被全库历史积压永久拖住）；低于 `queueLowWater` 继续、高于 `queueHighWater` 等待（高低水位）。
  单次等待上限 30s、整轮预算 120s（`ASSETVAULT_SCAN_GATE_MAX_WAIT_MS` / `ASSETVAULT_SCAN_GATE_BUDGET_MS`）；
  预算用尽只记一条 `discovery_throttle_budget_exhausted` 并继续扫，**不把扫描判成失败**。
- **实测**：10 万文件的 runner 基准，峰值 RSS **323MB**，`enqueueSingle = 0`（全部走批量入队）。

> 口径：`maxScanFiles`（默认 2 万）仍是硬上限，超出照旧 truncated —— 变的是**内存与入队节奏**，
> 不是"能扫无限多"。

---

## 5. 缓存

### 5.1 缓存类型与键

`cacheKey = sha256(kind | 内容身份 | 版本键 | limitsHash | extra)`

| kind | 内容 | 版本键 |
|---|---|---|
| `archive-listing` | zip/7z/rar 目录条目 | `archive:<container>:v<ARCHIVE_PARSER_VERSION>` |
| `upkg-listing` | unitypackage 资产表 | `upkg:v<UNITYPACKAGE_PARSER_VERSION>` |

- **内容身份 = `contentIdentity(asset, liveStat)`**（`services/pipeline/stages.ts`），只有两种：
  - **强**：`sha256:<sha>` —— **仅当** `assets.sha256_state === 'ok'` **且磁盘现状与行一致**时成立
    （`liveMatchesRow`：size 相同、mtime 差 ≤ 2ms，容忍 ISO 串的四舍五入）。文件被换掉后不再冒充强键。
  - **弱**：`weak:<assetId>:<path_norm>:<size>:<mtimeMs>[:<ino>:<dev>]` —— 只对"同一资产、同一路径、同一份文件"有效。
    v0.6.1 之前是裸 `size:mtime`：两个不同文件会撞同一个键、互相复用到**错误的目录**（审计 F1）。现在带
    assetId + path_norm 兜底；`ino/dev` 仅在有效（>0）时追加，挡住"同路径同 size+mtime 的替换"；
    Windows 上 ino 可能为 0/不稳定，此时退化为不含 ino 的格式，避免缓存空转。
  - **命中校验**：调用方可传 `expect.contentSha`，与条目记录的 `content_sha` 不符 → 视为脏条目丢弃（drop + miss），
    防"DB 行被改 / 键撞了"（审计 F3）。`cache_entries.weak`（schema v6）标记该条是强键还是弱键，供诊断与淘汰区分。
- **限制变化自动失效**：`limitsHash` 包含所有限制值 → 改上限后旧缓存不会被当成同结果。
- **解析器升级只失效相关 kind**：升级 archive 解析不会让缩略图 / 哈希失效。
- **版本键当前都是 3**：`HASH_VERSION`、`ARCHIVE_PARSER_VERSION`、`UNITYPACKAGE_PARSER_VERSION` 均为 3；
  任一语义/限制变化就 +1，只让对应 kind 的旧缓存失效（不会牵连哈希与缩略图）。

### 5.2 复用规则

- 相同内容 + 相同版本 → 复用**纯解析结果**，但为每个资产**重新建立关联**（`replaceArchiveEntries`）。
- 复用不会合并两个资产的用户数据（标签 / 收藏 / 分类 / 套装 / 用户图各自独立）。
- 用户自加图片永远不会被缓存清理逻辑触碰。

### 5.3 落盘与淘汰

- 文件：`data/cache/<kind>/<key 前2位>-<key>.json`；DB 表 `cache_entries` 只存元数据。
- **原子写**：`.tmp-<pid>-<rand>` → `rename`；崩溃残留由启动时 `pruneTemp()` 清理。
- 坏 JSON / 文件丢失 → 读时自愈（删条目、返回 null、重新计算）。
- GC：先删超过 `cacheMaxAgeDays` 的，再按 `last_used_at` LRU 删到 `cacheMaxBytes` 以下，
  保留最近 `cacheKeepEntries` 条；**只会删缓存根内的文件**（路径前缀校验）。

---

## 6. 取消、重试、崩溃恢复

- **取消**：`pipeline.cancelAsset(assetId)` 对运行中任务触发 `AbortController`；
  哈希按块、归档按条目、upkg 按 tar 条目、图片在 decode/encode 之间检查。
  取消后的临时文件由 `finally` 清理；已写入的基础建档不回滚（部分完成是合法状态）。
- **重试**：自动指数退避；人工 `POST /api/pipeline/tasks/:id/retry` 会重置 attempts。
- **崩溃恢复**：启动时 `recoverIndexTasks()` 把 `running → queued`（不增 attempts）、
  到期 `waiting_retry → queued`，并写 `pipeline_events(event='recovered')`。
- **jobs 级恢复**：v0.6.1 起不再"启动即回收一切在飞作业"，而是等**租约过期**（60s）再接管：
  `reapExpiredLeases()` 只动已过期的行、接管时 `lease_token+1`，仍在心跳的活任务不受影响（见 §3.1）。
- **反复崩溃保护**：同一作业已恢复 3 次 → 标 `failed` 并写原因，避免无限重启循环。
- **单写入者锁**：`<dataDir>/pipeline.lock`（pid + host）。
  拿不到锁的实例**既不启动 pipeline、也不启动 jobs runner**（`if (lock.acquired) runner.start(400)`），
  只提供 HTTP；作业留在库里排队，不会两个进程互相抢任务/重置 running。
  桌面版的 Electron 单实例锁不覆盖 CLI，因此这个锁是必要的第二道闸；租约（§3.1）则是进程死掉后的第二层。

---

## 7. 安全边界

- 归档条目路径统一走 `safeEntryPath`：拒绝绝对路径、盘符、UNC、`..`、NUL；
  读条目只按"归档内路径"取，从不把条目路径直接当磁盘路径。
- 高压缩比 / 超多小文件 / 超长路径 / 异常元数据 → 限制或跳过，绝不静默解压。
- 图片解码用 `limitInputPixels` 限制像素；损坏图返回明确状态，不产生半张图。
- 临时文件只写系统临时目录或 `data/cache`，命名带 pid+随机串，`finally` 清理。
- 清理逻辑只操作 AssetVault 自己的缓存目录；**任何清理都不会删除用户素材**。
- 日志不记录 GitHub token；错误消息包含文件路径与阶段，便于定位但不 dump 整个异常。

---

## 8. HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/pipeline` | 总览：计数、每阶段、缓存、内存、最近失败、限制 |
| GET | `/api/pipeline/tasks?state=&stage=&assetId=&limit=` | 任务列表（带 path/size） |
| GET | `/api/pipeline/tasks/:id` | 单任务 + 资产 |
| GET | `/api/pipeline/events?after=&limit=` | 诊断事件（stale/limited/retry/failed/recovered…） |
| POST | `/api/pipeline/tasks/:id/retry` | 人工重排（attempts 归零） |
| POST | `/api/pipeline/tasks/:id/cancel` | 取消（运行中走协作取消） |
| POST | `/api/pipeline/assets/:id/reindex` | 重新入队整条阶段链 |
| POST | `/api/pipeline/assets/:id/boost` | 交互式提权（用户正在看） |
| POST | `/api/pipeline/pause` / `resume` | 暂停/继续领取 |
| POST | `/api/pipeline/gc` | 手动回收缓存 |
| GET/PUT | `/api/pipeline/limits` | 查看/保存限制（保存后需重启） |

前端：「作业」面板内的「流水线」页签（2s 轮询，页面隐藏时暂停）。

---

## 9. 数据模型（schema v6）

v0.6.0 / v5 新增：

- `index_tasks`：阶段任务队列（唯一活跃索引 `(asset_id, stage)` 去重；`depends_on` 依赖）
- `pipeline_events`：诊断事件（带 `asset_id`/`stage`；v0.6.1 起按保留策略有界裁剪，见 §9.1）
- `cache_entries`：缓存元数据（文件本体在 `data/cache`）
- `assets` 新列：`index_state`、`index_error`、`indexed_at`、`content_version`

v0.6.1 / v6 只加列与索引（不动既有列语义）：

- `jobs`：`holder TEXT`、`lease_until TEXT`、`lease_token INTEGER NOT NULL DEFAULT 0`、
  `heartbeat_at TEXT`（见 §3.1），并加索引 `ix_jobs_lease(state, lease_until)` 供过期接管扫描。
- `cache_entries`：`weak INTEGER NOT NULL DEFAULT 0` —— 该条缓存的身份是否来自 size/mtime 的弱候选，
  供诊断与淘汰区分强键/弱键（见 §5.1）。

迁移：`SCHEMA_VERSION 4 → 5 → 6`，启动时幂等执行；只加表/列/索引，不改既有列语义。
旧库升级后 items/assets/tags/collections/avatar 关联一律原样保留。

**回滚**：v0.6.0 代码可以打开 v6 库（多出的 `jobs.holder/lease_until/lease_token/heartbeat_at`、
`cache_entries.weak` 列会被忽略），但旧代码不做租约围栏、也不读写 `weak`（缓存仍能命中，只是少了"强/弱"标记）。
回滚前先停服务再备份 `vault.db` + `-wal` + `-shm`（只复制主库文件会因 WAL 重放导致不一致）。

### 9.1 事件保留（v0.6.1 task-13）

`job_events`（作业状态转移 + 诊断）与 `pipeline_events`（流水线诊断）是**有界**的取证数据，不是无限日志。
保留策略用 `settings.event_retention`（JSON；启动与每轮读取，热更新）：

| 键 | 默认 | 语义 |
|---|---|---|
| `jobDays` | 30 | `job_events` 保留天数（0=不按时间删） |
| `jobMaxRows` | 100000 | `job_events` 条数上限（0=不限） |
| `pipelineDays` | 14 | `pipeline_events` 保留天数 |
| `pipelineMaxRows` | 200000 | `pipeline_events` 条数上限 |
| `batchSize` | 200 | 单批删除上限（clamp 1..500，避免长事务） |
| `coalesceWindowMs` | 60000 | `discovery_throttled` 同 job+event 合并窗口（0=关闭） |

- **保护边界（条数上限也不得突破）**：`job_events` 只删终态作业（`done`/`cancelled`/`abandoned`）的事件；
  `failed`（可 retry）、`paused`（用户持有）与任何在飞/待恢复作业一律保留。`pipeline_events` 只删
  "本任务不在飞且该资产名下没有活跃任务（queued/running/waiting_retry）"的事件。可删集合已空但仍超
  条数上限时，本轮记录 `blocked` 后停止——**绝不为达标而删受保护事件**。
- **有界执行**：单语句/单事务删除 ≤ `batchSize`（≤500）行，批间 `setImmediate` 让出；每轮最多 20 个删除批。
- **触发**：流水线启动 5s 后首跑，此后默认每 10min 一轮（`ASSETVAULT_EVENT_RETENTION_MS` 可覆盖），
  timer 均 `unref`；不进入作业/扫描热路径。
- **可重试 + 诊断**：每轮结果写 `settings.event_retention_state`（`{at, deletedJobEvents, deletedPipelineEvents,
  batches, error, consecutiveFailures, blocked}`）；失败不推进游标，下一轮自动重试，成功清零失败计数。
- **归档方式**：分段删除（不建归档表、不做 `archive` 迁移）；需要长期取证请依赖服务器日志/外部备份。
  **不自动 `VACUUM`**：删除只释放页内空间，磁盘回收需手动 `VACUUM`（或依赖后续更大规模清理复用空闲页）；
  不改变 `auto_vacuum`。清理只动两张事件表，**绝不删除 assets/items/缓存/媒体文件**。
- **进度事件**：流水线进度不是事件（`index_tasks.bytes_done/items_done` 列，400ms 批量 flush），因此无高频
  进度事件需要节流；唯一可能高频的 `discovery_throttled` 在窗口内只更新最后一条的 `detail.count/lastAt`
  （同 `job_id` + event，绝不跨作业合并）。

---

## 10. 基准与验收

```bash
node --import tsx scripts/bench-pipeline.mjs                 # 默认 1000 小文件 + 100MB 大包
node --import tsx scripts/acceptance-pipeline.mjs            # 36 项流水线验收
node scripts/test.mjs                                       # 全仓单测
```

基准输出 JSON 落在 `logs/bench-v06-*.json`（含 Node/CPU/冷热状态/数据量/限制指纹），
字段定义见脚本头注释。**不预先承诺百分比**：以同机同数据集的前后对比为准。

### 本机实测（WSL2 / Node v22.22.0 / 8 vCPU）

| 场景 | 数据量 | 发现 | 建档 | 深度索引 | 峰值 RSS | 事件循环 p95 / max | 缓存命中率 |
|---|---|---|---|---|---|---|---|
| 1000 小文件 + 100MB 大包 | 1004 个资产 / 105MB | 10ms（98,228 files/s） | 446ms（2,250 assets/s） | 10.6s | 482 MB | 5ms / 1266ms | 99.0%（第二轮） |
| 仅 500 个小文件（对照） | 504 个资产 / 0.19MB | 11ms | 200ms | 5.8s | 319 MB | 6ms / 626ms | 97.8% |
| 仅 500 个小文件（0.5.1 串行内联） | 504 个资产 / 0.19MB | 4ms | 155ms | 3.7s | 270 MB | 3ms / 220ms | —（无缓存） |

> 上表是 v0.6.0 的首次实测（fixture 含 100MB 大包）；下表是 v0.6.1 优化前后的**同 fixture 对照**，
> 两组数字来自不同数据集，不要横向互比。

#### v0.6.1 前后对比（同机 / 同 fixture / 同限制指纹）

原始输出：`logs/bench-costs-pipeline-*.json`、`docs/verification/evidence/v061-perf/`。

| 指标（500 文件 = 3000 任务） | v0.6.1 前 | v0.6.1 | 变化 |
|---|---|---|---|
| 索引总耗时 | 4830 ms | **3321 ms** | **−31%** |
| 预处理语句 `prepare` 次数 | 36666 | **1041** | **−97%** |
| 资产状态刷新 `refresh` 次数 | 3000 | **500** | **−83%** |
| 峰值 RSS | 286 MB | **172 MB** | **−40%** |

| 指标（1000 文件 = 6000 任务） | v0.6.1 前 | v0.6.1 | 变化 |
|---|---|---|---|
| 索引总耗时 | 10918 ms | **7625 ms** | **−30%** |
| 峰值 RSS | 377 MB | **183 MB** | **−51%** |

- 固定开销的两处来源被去掉：① SQL 语句不再每次现 prepare（缓存后 `prepare` 从 36666 降到 1041）；
  ② 资产状态汇总不再"每任务一次"，改在**链尾**只刷一次（`countActiveIndexTasks==0` 时才 `refreshAssetState`），
  3000 → 500。这两项与数据量无关，所以小数据集上收益同样明显。
- 峰值 RSS 的下降主要来自发现层有界化（§4.1）与按批入队，不再是"先把整棵树收进内存"。

> **诚实结论**：v0.6.0 刚拆出流水线时，纯小文件吞吐比 0.5.1 的串行内联慢约 1.5–1.6×（多出来的是 6 条任务账本
> ——入队/领取/进度/终态——与按阶段的数据库往返）。v0.6.1 削掉固定开销后，**500 文件 3.3s，已基本追平
> 0.5.1 的 3.7s**；换来的是大包解析不再占住整条队列、资源有上限、可取消/可恢复、失败可诊断。
> 如果以后还嫌慢，正确的方向是把"小文件的多个阶段"合成一个批任务，而不是牺牲隔离性。
>
> 1000 个内容相同的小 zip 共享同一缓存键：首轮少数真实解析、其余命中目录缓存，但每个资产仍各自
> 写入 `archive_entries`（缓存复用不混同业务身份）。
>
> 事件循环尖峰：JS heap 仅 ~21MB 而 RSS ~390MB → 原生侧（sharp/SQLite）单次停顿，不是 JS 长任务；
> 100MB 大包单独解析实测 max 2ms、峰值 163MB。

---

## 11. 已知限制 / 下一轮

- 7z / rar 的内嵌图片仍不抽缩略图（与 0.5.1 产品口径一致）；zip 的内层包只展开 1 层。
- 哈希与目录解析并行，首轮目录缓存可能是弱身份；第二轮起才稳定走 sha256 键。
  v0.6.1 起弱键带 `assetId + path_norm [+ ino/dev]`，不会跨文件串键——弱身份现在只影响**命中率**，不影响正确性。
- `maxScanFiles`（默认 2 万）仍是硬上限：超出会 truncated，需要多轮扫描 + 增量应用。
  发现层已经流式（§4.1），所以这条限制来自**配置**，不再来自内存。
- sharp 的 decode 不可真正中断：取消是"立即返回 + 后台解码自然结束"；要硬停需进程隔离。
- 多实例并发只在"文件锁 + 租约"层面成立：抢不到 `pipeline.lock` 的实例**完全不跑** jobs（不是跑一半）；
  要让第二个实例接手，得先停掉第一个进程。
- 缓存淘汰只看 `cacheMaxBytes` / `cacheMaxAgeDays` / `cacheKeepEntries`，不区分强弱键；
  弱键首轮必然 miss，命中率天然低于强键，这是已知且可接受的代价。

### 已收敛（v0.6.1）

- 发现层不再保留全量 `filesOut` / `seen`（§4.1）——"接入 `onBatch`"这条 TODO 已完成。
- `jobs` 具备租约与围栏（§3.1）——"lease/heartbeat"这条 TODO 已完成；跨进程的"谁在跑"由租约接管覆盖。
- 作业 / pipeline 事件按 §9.1 的有界保留策略自动裁剪（默认 30 天/10 万 + 14 天/20 万；只删终态、不 VACUUM）。
