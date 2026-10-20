# AUD-04 租约污染对抗矩阵（task-25）

> 基线：`b77ea2f6a687ddba2380da6545e424db31c0e81b`（v0.6.1；工作树仅 .lnk 未跟踪）。
> 性质：**只读审计 + 对抗脚本**；未改实现代码。全部用例在 `os.tmpdir()` 的一次性库上执行，未触碰生产 `data/vault.db`。
> 复现：`node --import tsx test/adversarial/aud04-lease-pollution.mjs` → 原始输出 `logs/aud04-lease-pollution.log`。

## 1. 结论摘要

**jobs 级围栏成立；index_tasks 进度/终态/重试与 asset/scan 数据写入在接管后仍会落地（审计时 7 处 GAP）。FIX-02（v7）关闭 index_tasks 4 处（§6），FIX-07（JobFence）关闭 asset/scan 3 处（§7）——修复后复跑 24/0。**
现有 26 条 `test/pipeline/lease.test.ts` 与 24 条 `test/adversarial/crash-instance-clock.mjs` **只覆盖 jobs 状态机、租约回收与实例锁**，没有一条断言"旧 worker 的 index_tasks / 资产写入不落地"——与实测缺口一致。

## 2. 审计矩阵（期望 vs 实测）

| 面 | 期望 | 实测（脚本 ID） | 判定 | 代码位置 |
|---|---|---|---|---|
| jobs 状态转移 | 旧持有者迟到转移被拒 | `LeaseLostError(409)`，状态/事件不变（A-4） | ✅ | `apps/server/src/db/repo.ts:896-918`（CAS holder+lease_token） |
| jobs 诊断事件 | 旧持有者迟到事件被拒 | `logJobEvent`=false，事件数不变（A-5） | ✅ | `apps/server/src/db/repo.ts:934-970`（EXISTS holder+token） |
| 续租 | 错 holder/token 续租失败 | `renewLease`=false（A-6） | ✅ | `apps/server/src/db/repo.ts:817-826` |
| 领取/回收 | 多 runner 单赢家、过期可接管 | token 递增、CAS 单赢家（A-1..A-3） | ✅ | `repo.ts:797-812`、`repo.ts:843-880` |
| index_tasks 进度 | 接管后旧 worker 进度被拒 | **写入落地** `bytes_done=111`、`error=stale-writer`（B-1c） | ❌ GAP | `repo.ts:1770-1781`（无条件 UPDATE by id） |
| index_tasks 终态 | 旧 worker 终态被拒、接管者可写 | **旧 `failed/OLD` 落地**，接管者 `done` 变 no-op（B-2b/2c） | ❌ GAP | `repo.ts:1788-1797`（`requireRunning` 只判 `state='running'`，无 owner/token） |
| index_tasks 重试 | 旧 worker 重试被拒 | **`waiting_retry` 落地**（B-3） | ❌ GAP | `repo.ts:1804-1809`（无条件 UPDATE） |
| asset 缺失标记 | 接管后旧 runner 写入被拒 | **`asset.status=missing` 落地**（C-1） | ❌ GAP | `repo.ts:630`（`markAssetsMissing` 无 job 上下文） |
| item 更新 | 同上 | **`title=STALE-TITLE` 落地**（C-2） | ❌ GAP | `repo.ts:309-322`（`updateItem` 无 fencing） |
| 扫描批次清单 | 同上 | **`insertScanAssetsBatch` 落地**（C-3） | ❌ GAP | `repo.ts:450-462`（TEMP 表无 job 作用域） |
| reap × heartbeat | 同窗口不能同时成功 | 边界 +999/+1000/+1001 均互斥、token 状态一致（D-*） | ✅ | `repo.ts:817-826` vs `843-880` |
| 多任务并发领取 | 每条恰一个持有者 | 6 并发领 3 job → 各 1 次（E-1）；接管后旧写入被拒（E-2） | ✅ | — |

## 3. 关键观察（含非阻塞说明）

1. **index_tasks 完全没有租约列**：`claimIndexTask` 只置 `state='running'`（`repo.ts:1731-1767`），无 owner/token；因此"谁领的"不可判定。B-2b 说明终态 CAS 的 `requireRunning` 反而成了**旧 worker 的合法写入口**：B 重领后 state 仍是 running，旧 worker 的 `failed` 赢下 CAS，B 的 `done` 变 no-op → 终态被旧结果覆盖。
2. **reap 只回收 jobs，不回收 index_tasks**：`reapExpiredLeases`（`repo.ts:843-880`）只置 jobs；`recoverIndexTasks` 仅在 `pipeline.start()`（`pipeline.ts:78-82`）调用。已运行实例接管时不会重置 running 任务，**死 worker 的 index_tasks 可能永久停在 running**（无超时回收器）。
3. **续租不判过期**：`renewLease` 只 CAS holder+token（`repo.ts:817-826`），D-1001 显示过期后若旧进程先跑到 renew，仍可续租成功（reap 随后 0）。单实例下可自愈，多实例下意味着**接管是 reap 驱动的**：另一实例必须先 reap 才能破坏旧持有者的写权限。建议明确该语义或改成"过期后禁止 renew"。
4. **runner 的 jobs 级中止是阶段边界/50ms 让渡点检查**（`runner.ts:96-102`、`yieldIfDue`、`462-471`），长同步段内仍可能继续写；jobs 级转移会被 token 拒，但**资产写入没有任何 token 校验**，这是 GAP 的根因。
5. 生产路径影响：单实例 + 正常心跳下不会触发；**跨实例接管（第二实例/双开）+ 旧进程未退出**或**长同步段 > leaseMs** 时才会污染。当前 Windows 验收未做"双实例同时处理同一作业"的对抗，属验收空白（非本轮回归）。

## 4. 最小补丁建议（本轮不改实现，供后续任务）

- **P0 index_tasks 围栏**：给 `index_tasks` 增加 `lease_owner`/`lease_token`（或复用 jobs.token）；`claimIndexTask` 返回 token；`updateIndexTask/finishIndexTask/retryIndexTask` 增加 `WHERE id=? AND state='running' AND lease_owner=? AND lease_token=?`，0 行即丢弃；`pipeline.execute` 从 claim 行取 token 传入所有写点。
- **P1 资产写入围栏**：runner/pipeline 的批写（`markAssetsMissing/updateItem/insertScan*/deleteScanItemsThrough`、stages 写入）先在同一事务内 `SELECT 1 FROM jobs WHERE id=? AND holder=? AND lease_token=?`（或 UPDATE 触碰），不满足即中止；索引任务的资产写入用 P0 的 task token。
- **P1 接管即重置子任务**：`reapExpiredLeases` 命中 job 时同步 `UPDATE index_tasks SET state='queued' WHERE job 关联 AND state='running'`（或用 30s 无心跳超时回收器），避免死任务永久 running。
- **P2 语义明确**：`renewLease` 是否允许"过期后未 reap 前续租"；补一条双顺序竞争测试（当前 D 仅单顺序）。
- 对抗回归：把 `aud04-lease-pollution.mjs` 的 B/C 段并入 `test/adversarial`（现在已是独立脚本）；修复后预期 B/C 全绿。

## 5. 证据

- 脚本：`test/adversarial/aud04-lease-pollution.mjs`（新增，只读实现）。
- 输出：`logs/aud04-lease-pollution.log`（14 passed / 7 gap，FIX-02 前）；`logs/aud04-lease-pollution-fix02.log`（20/3，FIX-02 后）；`logs/aud04-lease-pollution-fix07.log`（**24 passed / 0 gap**，FIX-02+07 后）。
- 代码引用行号均以 `b77ea2f` 工作树为准；§6 行号以 FIX-02 工作树为准。

## 6. FIX-02 回归（v7，2026-10-21；task-29 工作树）

实现（未提交工作树，`SCHEMA_VERSION = 7`）：index_tasks 增加 `owner/lease_token/job_id`（schema.sql、migrate.ts）；
`claimIndexTask(stage, owner)` 领取即写 owner+token+1；`updateIndexTask/finishIndexTask/retryIndexTask` 支持 fence 参数
（`WHERE id=? AND owner=? AND lease_token=? AND state='running'`，0 行返回 false/null）；reap 时 `resetRunningTasksForJob(jobId)`
把该作业的 running 子任务回 queued 并换租约；pipeline 的 claim/finish/retry/progress 全部带 fence（pipeline.ts:366/378/388/440/450/457/471/484/493/541）。

复跑结果（`node --import tsx test/adversarial/aud04-lease-pollution.mjs`，20 passed / 3 gap）：

| 面 | FIX-02 前 | FIX-02 后 | 判定 |
|---|---|---|---|
| index_tasks 进度（B-1c） | bytes_done=111 落地 | 返回 false、bytes_done=0 | ✅ 关闭 |
| index_tasks 终态（B-2a/b/c） | 旧 failed 覆盖新 done | 旧写入 null；新 done 成功；旧 failed 迟到仍 null | ✅ 关闭 |
| index_tasks 重试（B-3） | waiting_retry 落地 | 返回 null，仍 running/owner=B | ✅ 关闭 |
| reap 重置子任务（F-1..F-4） | 无此逻辑（死任务可能滞留） | reap 后 queued/owner=NULL/token+1；旧终态被拒；B 重领可 done | ✅ 新增通过 |
| asset/scan 写入（C-1..C-3） | markAssetsMissing/updateItem/insertScanAssetsBatch 落地 | **仍落地**（FIX-02 未覆盖） | ❌ 残余（3） |
| jobs 围栏 / 同窗口 / 并发（A/D/E） | PASS | PASS（未回归） | ✅ |

**残余 3 处**：`markAssetsMissing`（repo.ts:630）、`updateItem`（repo.ts:309）、`insertScanAssetsBatch`（repo.ts:450）
仍无 job/task 围栏；建议按 §4 P1「资产写入围栏」跟进（同事务校验 job holder/token，或复用 task fence）。
兼容性说明：`updateIndexTask/finishIndexTask/retryIndexTask` 未传 fence 时仍走旧无围栏路径（供测试/诊断）；
生产调用点已 grep 确认只有 pipeline.ts 且全部传 fence。

回归：FIX-02 工作树 `npx tsc --noEmit` = 0；全量 `node scripts/test.mjs` = **672 tests / 649 pass / 0 fail / 22 skip / 1 todo**（`logs/g2-wsl-fix02.log`）。

## 7. FIX-07 回归（JobFence，2026-10-21；task-35 工作树）

实现：repo.ts 新增 `JobFence { jobId, holder, token }` 与 `JOB_FENCE_SQL`（jobs 行仍属该 holder+token 才放行）；
`updateItem/insertScanAssetsBatch/markAssetsMissing` 增加可选 `fence` 参数；runner 的派生写入全部带 fence
（runner.ts:270/286/345/362：source_url 回填、TEMP 清单、scan 判缺、apply 缺失标记）；HTTP/用户操作不传 fence 保持旧行为（设计，非派生写入）。

复跑（C 段改为 JobFence 正/反例；`logs/aud04-lease-pollution-fix07.log`）→ **24 passed / 0 gap**（FIX-07 前 20/3）：

| 项 | FIX-07 前 | FIX-07 后 | 判定 |
|---|---|---|---|
| C-1 旧 runner markAssetsMissing(fence) | status=missing 落地 | **0 行**（status=present） | ✅ 关闭 |
| C-2 旧 runner updateItem(fence) | STALE-TITLE 落地 | **0 行**（title 不变） | ✅ 关闭 |
| C-3 旧 runner insertScanAssetsBatch(fence) | 写入 TEMP 清单 | **0 行**（scan_assets=0） | ✅ 关闭 |
| C-4 正例：新持有者同 fence | — | 写入成功（missing / scan_assets=1） | ✅ 对照 |

**最终矩阵**：A jobs（4）+ B index_tasks（6）+ C assets/scan（4）+ D 同窗口（3）+ E 并发（2）+ F reap 重置（4）= **24 passed / 0 gap**。
新增回归测试：`test/scan/writes-fence.test.ts`（6）、`test/pipeline/index-lease.test.ts`（9）、`test/scan/preview-lifecycle.test.ts`（9，FIX-01）。
全量：`npx tsc --noEmit` = 0；`node scripts/test.mjs` = **687 tests / 664 pass / 0 fail / 22 skip / 1 todo**（`logs/fixall-tsc-tests.log`）。
