# AUD-07 诊断 / 统计口径 / skipped-todo 审计（v0.6.1，只读）

- 基线：`b77ea2f`（`git rev-parse --short HEAD`；审计开始时工作树仅 `asset-vault - 快捷方式.lnk` 未跟踪）
- 方式：只读代码审计 + 临时 SQLite/临时目录复现；**未改实现代码、未触碰生产 data**（Windows 生产实例已停，库 v6）
- 复现脚本（scratch，gitignore 的 logs/）：`logs/aud07-stats.ts`、`logs/aud07-preview.ts`、`logs/aud07-retry.ts`；全量单测日志 `logs/aud07-tests.log`
- 全量测试现状：`656 tests / 633 pass / 0 fail / 22 skipped / 1 todo`（与 V0.6.1-REPORT.md:14 一致）

## 0. 结论摘要

| 编号 | 审计项 | 等级 | 判定 |
|---|---|---|---|
| AUD-07-1 | CLI `/api/health.version` 恒 0.1.0 | 中 | **确认**：CLI 入口未传 version，服务端兜底 0.1.0；Electron 正常 |
| AUD-07-2 | EBUSY/占用被归为 unrecognised container | 中 | **确认**：`detectContainer` 吞掉所有 open errno 直接返回 null，扩展名兜底不可达 |
| AUD-07-3 | /api/stats 与 /health.counts 口径 | 低-中 | 两端点**同源**（同 repo.stats()）→ 数值一致；但口径不自洽（assets 含 missing/含已回收条目的资产、无 jobs/trashed 维度） |
| AUD-07-4 | 22 skipped + 1 todo 是否合理 | 低 | 21 条样本门控 + 1 条 root-EACCES 平台门控（条件明确，不算过宽）；**1 条 todo 已过时**（运行期已有 retryTimer） |
| AUD-07-5 | 预览 failed 后 runner 是否留下 scanning | **高**（AUD-01） | **确认**：runner/生成器都无失败收尾；`expireScanPreviews` 只处理 ready/partial → 永久 scanning 并阻塞同路径重扫 |
| AUD-07-6 | 附带发现：pipeline retryable 恒真 | 低 | `attempts < max` 两侧相同 → 表达式恒等，重试判定实际只看 attempts（分类修复后需同步修） |

报告一致性：V0.6.1-REPORT.md:115/164-166 已把 ①②⑤ 列为"Windows 侧发现（非阻塞）"，与代码一致；③ 报告未提及；④ 报告只写 "todo=已知遗留"（V0.6.1-REPORT.md:14），未说明其已过时。

---

## AUD-07-1 CLI health.version 恒 0.1.0

**代码位置 / 根因**
- `apps/server/src/main.ts:3-7` 调 `startAssetVault({port,host,dataDir})`，**没有 version**。
- `apps/server/src/server.ts:96` `registerRoutes(..., version: opts.version ?? "0.1.0", ...)` → 兜底 0.1.0。
- `apps/server/src/http/routes.ts:244-246` `/api/health` 原样返回 `deps.version`。
- `apps/server/src/http/routes.ts:1656` `/api/update-check` 也用 `deps.version` 当 `current` → CLI 的"当前版本"也错。
- 对照：Electron `apps/desktop/main.mjs:57-58` 已传 `version: app.getVersion()`（package.json 版本）→ 只有 CLI/脚本入口受影响。报告 V0.6.1-REPORT.md:164 已记录（v0.5.1 既有）。

**复现（本机，临时 data 目录，不碰生产）**
```bash
cd /root/Code/asset-vault
D=$(mktemp -d); ASSETVAULT_DATA=$D PORT=7399 timeout 25 node --import tsx apps/server/src/main.ts &
sleep 2; curl -s http://127.0.0.1:7399/api/health; kill %1; rm -rf $D
```
输出（实测）：
```
{"ok":true,"version":"0.1.0","dbPath":"/tmp/<tmp>/vault.db","roots":[],"counts":{...}}
package.json: "version": "0.6.1"
```

**最小修复建议**
1. `apps/server/src/main.ts` 读取仓库根 package.json 并传 version（只改 CLI 入口，测试/嵌入式默认不变）：
```ts
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version?: string };
const handle = await startAssetVault({ ...existing, version: pkg.version });
```
2. 或（更彻底）`server.ts:96` 的兜底从 `"0.1.0"` 改为读取 package.json；需确认没有测试依赖 0.1.0（当前 test/ 与 apps/server/test 均无 0.1.0/health.version 断言，grep 为空）。

**测试建议**
- smoke：以临时 dataDir 起 server → `GET /api/health` 的 `version` 必须 === `package.json.version`；顺带断言 `/api/update-check` 的 `current` 同值。

---

## AUD-07-2 archive 把 EBUSY/占用归为 unrecognised container

**代码路径（错误分类链）**
1. `packages/core/src/archive/list.ts:157-164` `assertReadableFile` 只做 `statSync`；Windows 上"被独占但 stat 可见"的文件会通过预检。
2. `list.ts:125-138` `detectContainer`：`openSync/readSync` 外层 `catch { return null; }` —— **任何 errno（EBUSY/EPERM/EACCES/EMFILE…）都被吞成 null**，且此处直接 return，**扩展名兜底（list.ts:149-154）不可达**。
3. `list.ts:714-715` `listArchive` 见 container===null → `NOT_AN_ARCHIVE "unrecognised container (no known magic, no known extension)"`。
4. 若 open 成功、后续读流才 EBUSY：`list.ts:292-301` `translateArchiveError` 只特判 encrypted/ENOENT/EISDIR，其余一律 `NOT_AN_ARCHIVE "cannot read <container> (...): <原文>"`。
5. 下游：`services/pipeline/stages.ts:196` 直接 await core.list（无错误分类）→ `pipeline.execute` → `fail()` 存 `error_code=NOT_AN_ARCHIVE`；`pipeline.ts:451` `retryable = code!=="TIMEOUT" && !/ENOENT|EACCES|EPERM/ ? attempts<max : attempts<max` **两侧完全相同 = 恒只看 attempts**（EBUSY 会被重试到 max，但归类错误）。
6. runner 同步回退（无 pipeline）：`jobs/runner.ts:296`/`:410` 只记 `index asset N skipped` + `partial_failures`，作业仍可能 succeed，asset 停在 pending/error。
7. hash 分支对照：`packages/core/src/hash.ts:28-36` 把 EBUSY 归 `INVALID_INPUT "cannot read ..."`（消息带 EBUSY，code 不是专用错误）——V0.6.1-REPORT.md:166 说 "hash 阶段已正确报 EBUSY" 只在消息层面成立。

**复现**
- POSIX 代码路径（任何 open 失败都返回 null，连 .zip 扩展名也不再兜底）：
```bash
cd /root/Code/asset-vault
node --import tsx -e "import { detectContainer } from './packages/core/src/archive/list.ts'; console.log(detectContainer('/tmp'), detectContainer('/no/such/file.zip'))"
# 实测输出：null null   ← 后者证明 catch 在扩展名兜底之前 return
```
- 真 EBUSY 复现需要 Windows 独占打开（本机 WSL root 有 CAP_DAC_OVERRIDE，构造不出 EACCES/EBUSY；同 walk.test.ts:158-167 的既有平台限制）。Windows 现场证据：V0.6.1-REPORT.md:115/166。

**最小修复建议**
1. `detectContainer` 的 catch 区分 errno：`EBUSY|EPERM|EACCES|EAGAIN|EMFILE|ENFILE` → 抛 `AppError("FILE_BUSY" | "PERMISSION", ..., 409/403)`（或返回 sentinel 让 listArchive 映射）；其余（未知魔数/坏文件）仍 null。
2. `translateArchiveError` 增加同一 errno 映射（放在 ENOENT/EISDIR 之后、通用 NOT_AN_ARCHIVE 之前）。
3. 修正 `pipeline.ts:451` 的 retryable：`attempts < max && code !== "TIMEOUT" && !/ENOENT|EACCES|EPERM|EBUSY/i.test(message)`（按新的专用 code 判定更佳）。
4. 保留首个阶段错误到 `assets.index_error`（V0.6.1-REPORT.md:166 的建议），避免被后续阶段覆盖。

**测试建议**
- 纯函数单测：新增 `mapContainerOpenError({code:"EBUSY"})`（或把 errno 映射抽成可注入函数）→ 断言 FILE_BUSY/409。
- Windows 集成（可选，CI 外）：PowerShell `[IO.File]::Open(path,'Open','Read','None')` 持有后再扫描 → `error_code=FILE_BUSY`；释放后 retry 成功。
- pipeline 单测：stageArchive 抛 EBUSY → 任务 `waiting_retry` 且 `error_code=FILE_BUSY`（不是 NOT_AN_ARCHIVE），max attempts 后 failed。

---

## AUD-07-3 /api/stats 与 /health.counts 口径

**代码**
- `routes.ts:244-247`：`/api/health` → `counts: repo.stats()`。
- `routes.ts:1765`：`/api/stats` → `repo.stats()`。
- `db/repo.ts:2007-2018` `stats()`：
  - `items = COUNT(items WHERE status<>'trashed')`（排除回收站）
  - `assets = COUNT(assets WHERE status<>'trashed')`（**含 status='missing'**，且**未 join items** → 已回收条目的资产仍被计数）
  - `bytes = SUM(size) WHERE assets.status<>'trashed'`（同上，含 missing 与已回收条目资产）
  - `missing = COUNT(assets WHERE status='missing')`（同样不 join items）
  - `avatars = COUNT(avatars)`；`inbox = COUNT(items WHERE status='inbox')`
  - **没有 jobs 维度**（jobs 走 `/api/jobs`）；没有 trashed items/assets 计数。

**复现（临时库）**
```bash
cd /root/Code/asset-vault && node --import tsx logs/aud07-stats.ts
```
实测输出：
```json
{"stats":{"items":0,"assets":2,"bytes":0,"avatars":0,"inbox":0,"missing":1,"byCategory":[],"byAvatar":[]},
 "jobsRows":1,"itemsRows":1,"assetsRows":2,"trashedItems":1,"missingAssets":1}
```
（bytes=0 因为夹具 addAsset 未设 size；真实库含 missing 大小。）

**判定**：两个端点**数值必然一致**（同一函数），但"口径"不自洽：
- items=0 而 assets=2：已回收条目的资产仍计入总资产；
- `assets` 不是"present 资产数"，而是"非 trashed 资产数"（含 missing）；
- missing 会包含已回收条目的资产；
- 两个端点都没有 jobs / trashed 维度，诊断页与 health 的"counts"语义靠猜。

**建议**
- 若想保持兼容：在 docs/api.md 明确 counts 口径（assets 含 missing；items 排除 trashed；jobs 不在此接口），并新增 `trashedItems/trashedAssets`。
- 若要自洽：assets/bytes/missing 都 `JOIN items i ON i.id=a.item_id AND i.status<>'trashed'`；另给 `assetsPresent/assetsMissing` 与 `jobs:{queued,running,failed,...}`。
- 测试：临时库构造"trashed item + present/missing asset + 未完成 job"，断言 stats 各字段（按冻结口径）；HTTP 层 `inject` 断言 `/api/health.counts` deepEqual `/api/stats`（防止将来分叉）。

---

## AUD-07-4 22 skipped + 1 todo

**22 skipped 明细**（`grep '# SKIP' logs/aud07-tests.log`）
- 21 条 = **样本门控**（`AV_SAMPLES_DIR` 未设时跳过）：`packages/core/test/content/fixtures.ts:16-25`（默认 `%LIBRARY%`，Linux 上必然 `has()===false`）；分布在
  `packages/core/test/content/pipeline.test.ts`（:102,:202,:219,:229 …）、
  `packages/core/test/content/unitypackage.test.ts`（:12,:22,:31,:43,:65,:129 …）。
  分类：5×sample zip、1×backslash zip、3×7z、2×rar、10×unitypackage、1×"31MB unitypackage timeout" ⇒ 21。
- 1 条 = **平台门控**：`test/scan/walk.test.ts:158-167`，以 root 运行（CAP_DAC_OVERRIDE 绕过 0000）无法构造真实 EACCES；Windows ACL 语义不同亦跳过（所以 Windows 是 23 skip，见 V0.6.1-REPORT.md:162）。
- 判定：**跳过条件本身不算过宽**（逐用例显式 `has()`/`t.skip`，没有全局 blanket skip），但流程上有两个问题：
  1) 默认 CI 无样本 → 真实 zip/7z/rar/unitypackage 解析覆盖为 0，解析器回归只能靠人工；
  2) V0.6.1-G-CHECKLIST.md:45-46 要求 "skipped 必须全部是样本门控" 与实际（root-EACCES）不符（报告 :162 已解释，但 checklist 措辞应改）。
- 建议：CI 增加带 `AV_SAMPLES_DIR` 的 leg 并断言 `skipped==0`（或固定白名单）；至少用 `7zip-bin` 在 fixture 里**生成**一个小 7z，覆盖 7z list/CRC 而不依赖外部样本；root-EACCES 分支可用注入 readdir 错误覆盖。

**1 todo（已过时）**
- `test/pipeline/index-tasks.test.ts:327-339`：todo 理由 "pipeline.ts:78 只在 start() 调 recoverIndexTasks；loop 只 claimIndexTask('queued') → 退避到期后没有任何组件把 waiting_retry 排回 queued"。
- 但当前实现 `services/pipeline/pipeline.ts:92-98` 已有 `retryTimer`（每秒 `promoteDueRetries()` 并 notify，注释明确 "verifier BUG-1"）。实测（`logs/aud07-retry.ts`）：`waiting_retry` 在 `pipeline.start()` 后 **100ms 内被提升并执行**（状态 skipped，资产缺失）。
- 判读：**用户可见缺陷已修**，todo 描述过时；但测试 body 直接 `claimIndexTask` 仍会失败（claim 本身不做提升），所以正确做法不是删断言，而是改为运行时集成测试：`pipeline.start()` → 等待 ≤1.5s 断言任务离开 waiting_retry（或显式调用 `promoteDueRetries()` 后 claim），并去掉 `{ todo }`。

---

## AUD-07-5 预览失败/崩溃后永久 scanning（runner 侧）

**代码**
- 创建即 scanning：`db/repo.ts:1482` `INSERT ... state='scanning'`。
- 生成器只在**成功路径末尾**写终态：`services/scanpreview.ts:164-208`（:192 state=ready/partial/failed；:197 updateScanPreview），**没有 try/catch/finally**；任何 throw（路径不存在、walk 取消、replaceScanPreviewItems 失败）都不写终态。
- runner 预览分支：`jobs/runner.ts:166-175` await `generateScanPreview(...)`；异常冒泡到 `runJob` catch → `stopFail`（`:123`）只处理 jobs/job_events；**runner 全文没有 scan_previews 引用**（grep 仅 apply finalize 的 previewId 参数）。
- 过期清理只覆盖 ready/partial：`db/repo.ts:1606-1609` `WHERE state IN ('ready','partial')`；scanning 永不进入 expired。
- 阻塞放大：`POST /api/scan/previews` 复用活跃预览（`routes.ts:730-732`，`findActiveScanPreview` 含 scanning，`repo.ts:1470`）→ 同路径再扫返回 `existing:true`，必须先手动 cancel（routes.ts:827-836）或 delete（:862）才能重扫。

**复现（临时库 + 真 runner）**
```bash
cd /root/Code/asset-vault && node --import tsx logs/aud07-preview.ts
```
实测：
```json
{"case":"generate-throw","job":"failed","preview":"scanning"}
{"case":"after-expire","preview":"scanning"}
{"case":"crash-scanning","job":"resolving","preview":"scanning"}
```
（第 2 行：`expireScanPreviews()` 后仍 scanning；第 3 行：模拟 runner kill/崩溃后 `recoverInFlight` + expire，预览仍 scanning。）

**runner 侧最小修复建议（AUD-01 由 core-identify 主责，这里只给 runner 证据）**
1. runner 预览分支加 `try/catch/finally`：失败时 `repo.updateScanPreview(previewId, { state: "failed", error: msg, finished_at: now() })`（租约丢失/CANCELLED 可记 cancelled），再把异常抛给 stopFail。
2. 启动恢复增加扫描预览 sweep：`state='scanning' AND (expires_at IS NULL OR expires_at < now)` → failed/expired（与 job 恢复解耦，因为 scan_previews 不参与 jobs 恢复）。
3. 给 scanning 也写 `expires_at`（或失败 TTL），`expireScanPreviews` 纳入 scanning（按超时而非状态）。
4. 明确 cancel：预览 job 被用户 cancel/暂停时，runner 无回调写 cancelled → 同样在 catch 中按 job 状态映射。

**测试建议**
- 不存在路径 → job failed 且 preview=failed+error+finished_at；
- 生成中断（子进程 kill / lease abort）→ preview=failed（或 cancelled）；
- 启动时存在 scanning+过期预览 → sweep 后 failed/expired，且同路径可重新创建预览；
- 失败后 `GET /api/scan/previews` 不再返回 scanning。

---

## AUD-07-6 附带：pipeline retryable 恒等（pipeline.ts:451）

`const retryable = code !== "TIMEOUT" && !/ENOENT|EACCES|EPERM/i.test(message) ? attempts < max : attempts < max;` 两侧相同，等价于 `attempts < max`。影响：TIMEOUT/ENOENT/EACCES 仍会重试到 max（与注释意图相反），且 EBUSY 分类修复后需要在这里显式判定。
建议：`const retryable = attempts < max && code !== "TIMEOUT" && !/ENOENT|EACCES|EPERM|EBUSY/i.test(message);`，并加单测（TIMEOUT 一次即 failed；ENOENT 不重试；普通错误重试）。

---

## 测试建议汇总（按优先级）

1. **P0** 预览失败终态 + 启动 sweep（AUD-07-5/AUD-01）：runner 分支 finally 写 failed/cancelled；scanning 超时 sweep；HTTP 层断言不再返回 scanning。
2. **P1** CLI 版本 smoke（AUD-07-1）：`/api/health.version === package.json.version`，`/api/update-check.current` 同值。
3. **P1** EBUSY errno 映射（AUD-07-2）：`detectContainer`/`translateArchiveError` 的 errno 映射单测 + pipeline 断言 `error_code=FILE_BUSY`；retryable 单测。
4. **P1** stats 口径（AUD-07-3）：冻结口径后的字段断言 + 两端点 deepEqual。
5. **P2** 样本 CI leg（AUD-07-4）：`AV_SAMPLES_DIR` leg 断言 skipped==0/白名单；7z 合成夹具；把 TODO 改为运行时集成测试。
6. **P2** root-EACCES：用注入 fs 错误覆盖分支（替代特权环境构造）。

## 复现命令索引

```bash
cd /root/Code/asset-vault
git rev-parse --short HEAD                      # b77ea2f
node scripts/test.mjs > logs/aud07-tests.log    # 656/633/0/22/1
node --import tsx logs/aud07-stats.ts           # stats 口径
node --import tsx logs/aud07-preview.ts         # preview 永久 scanning
node --import tsx logs/aud07-retry.ts           # waiting_retry 运行期提升（TODO 已过时）
# CLI version（临时 data）：
D=$(mktemp -d); ASSETVAULT_DATA=$D PORT=7399 timeout 25 node --import tsx apps/server/src/main.ts & sleep 2
curl -s http://127.0.0.1:7399/api/health; kill %1; rm -rf $D
# detectContainer 吞错：
node --import tsx -e "import { detectContainer } from './packages/core/src/archive/list.ts'; console.log(detectContainer('/tmp'), detectContainer('/no/such/file.zip'))"
```
