# v0.6.0 · 后台索引流水线、超大压缩包解析与缓存

> 目标：把「发现 → 建档 → 深度解析」解耦，让一个 2GB 的压缩包不再堵住整个扫描队列；
> 所有资源消耗有明确上限，任务可取消、可重试、崩溃后可恢复、失败可诊断。
>
> 本文是实现说明（不是提案）：所有默认值、状态、表结构都与代码一致
> （`apps/server/src/services/pipeline/*`、`apps/server/src/db/schema.sql`）。

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

---

## 5. 缓存

### 5.1 缓存类型与键

`cacheKey = sha256(kind | 内容身份 | 版本键 | limitsHash | extra)`

| kind | 内容 | 版本键 |
|---|---|---|
| `archive-listing` | zip/7z/rar 目录条目 | `archive:<container>:v<ARCHIVE_PARSER_VERSION>` |
| `upkg-listing` | unitypackage 资产表 | `upkg:v<UNITYPACKAGE_PARSER_VERSION>` |

- **内容身份**：优先完整 `sha256`（强）；没有时退化 `size:mtime`（弱候选，meta 里标 `weak=true`）。
  弱身份只用于"同一文件重复解析"的加速，不用于跨路径断言内容相同。
- **限制变化自动失效**：`limitsHash` 包含所有限制值 → 改上限后旧缓存不会被当成同结果。
- **解析器升级只失效相关 kind**：升级 archive 解析不会让缩略图 / 哈希失效。

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
- **反复崩溃保护**：同一作业已恢复 3 次 → 标 `failed` 并写原因，避免无限重启循环。
- **单写入者锁**：`<dataDir>/pipeline.lock`（pid + host）。
  拿不到锁的实例不启动 pipeline（HTTP 仍可用，任务会排队），避免两个进程互相抢任务/重置 running。
  桌面版的 Electron 单实例锁不覆盖 CLI，因此这个锁是必要的第二道闸。

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

## 9. 数据模型（schema v5）

新增：

- `index_tasks`：阶段任务队列（唯一活跃索引 `(asset_id, stage)` 去重；`depends_on` 依赖）
- `pipeline_events`：诊断事件（只增，带 `asset_id`/`stage`）
- `cache_entries`：缓存元数据（文件本体在 `data/cache`）
- `assets` 新列：`index_state`、`index_error`、`indexed_at`、`content_version`

迁移：`SCHEMA_VERSION 4 → 5`，启动时幂等执行；只加表/列，不改既有列语义。
旧库升级后 items/assets/tags/collections/avatar 关联一律原样保留。

**回滚**：v0.5.1 代码可以打开 v5 库（多出的表/列会被忽略），但不会处理遗留 `index_tasks`；
回滚到旧版前建议先备份 `vault.db` + `-wal` + `-shm`（只复制主库文件会因 WAL 重放导致不一致）。

---

## 10. 基准与验收

```bash
node --import tsx scripts/bench-pipeline.mjs                 # 默认 1000 小文件 + 100MB 大包
node --import tsx scripts/acceptance-pipeline.mjs            # 21 项流水线验收
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

> **诚实结论**：纯小文件吞吐上，流水线比 0.5.1 的串行内联慢约 1.5–1.6×——多出来的是 6 条任务账本
> （入队/领取/进度/终态）与按阶段的数据库往返。换来的是：大包解析不再占住整条队列、资源有上限、
> 可取消/可恢复、失败可诊断。如果未来更在意小文件吞吐，可以把"小文件的多个阶段"合成一个批任务，
> 而不是牺牲隔离性。
>
> 1000 个内容相同的小 zip 共享同一缓存键：首轮少数真实解析、其余命中目录缓存，但每个资产仍各自
> 写入 `archive_entries`（缓存复用不混同业务身份）。
>
> 事件循环尖峰：JS heap 仅 ~21MB 而 RSS ~390MB → 原生侧（sharp/SQLite）单次停顿，不是 JS 长任务；
> 100MB 大包单独解析实测 max 2ms、峰值 163MB。

---

## 11. 已知限制 / 下一轮

- 7z / rar 的内嵌图片仍不抽缩略图（与 0.5.1 产品口径一致）；zip 的内层包只展开 1 层。
- 哈希与目录解析并行导致首轮目录缓存可能是弱身份；第二轮起才稳定走 sha256 键。
- 扫描发现仍会为整棵树保留 `filesOut`（上限 2 万）；`walkCandidates` 已支持 `onBatch` 流式回调，
  生产接线（planFromGroups 分批）留作下一轮。
- sharp 的 decode 不可真正中断：取消是"立即返回 + 后台解码自然结束"；要硬停需进程隔离。
- 超大目录（>2 万候选）仍会 truncated；需要多轮扫描 + 增量应用。
- 作业事件 / pipeline 事件尚无自动保留策略（建议按 30/90 天归档）。
