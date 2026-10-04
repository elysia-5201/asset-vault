# TASK-4 独立验证报告（verifier）

生成时间：2026-10-04T02:4x+08:00（本机 18:3x UTC 的服务侧时间）
被测对象：`packages/core/src/contracts.ts`（冻结）、`apps/server/src/db/schema.sql`（冻结）、HTTP API v1（127.0.0.1:7317）
写作用域：`test/**`、`docs/verification/**`（+ 任务简报明确许可的 `logs/**.log`）。**未修改任何被测源码。**

---

## 0. 基线哈希（纪律 #8）

| 文件 | 本轮起始 md5 | 本轮最终 md5 | 说明 |
|---|---|---|---|
| packages/core/src/contracts.ts | 3b46a0ddc3561890492b0d339aea2dc0 | 88d01677c892304b766bb0d93e7e4cc5 | **测量期间被 lead 改动**：尾部新增 `normKey` + `PUNCT`（+8 行）。转移表 38–69 行逐字未变 → ①② 全量重跑 |
| apps/server/src/db/schema.sql | 8ff3c96d260b8f79b0e93adaf7994191 | d7790e78d8f1d828346d68820d81b930 | **测量期间被 lead 改动**：`items_fts` 去掉 `content=''`（contentless → 内容存储型）。③ 全量重跑 |
| scripts/test.mjs | 18e549c0caa5171c4e0782fa488453ae | 18e549c0caa5171c4e0782fa488453ae | 验收仪器，未被改动（也未被 verifier 改动） |

- 早先一轮（改动前）的 34/34 机测结果**按纪律作废**，下表所有数字均来自改动后的重跑；测量前后哈希一致（`logs/verifier-md5-before.txt` / `logs/verifier-md5-after.txt`）。
- ⚠️ 观察：`content=''` 被移除后 items_fts 变成内容存储型（列可读回、可普通 DELETE）。`contracts.ts` 注释里声明的 DM hash `6a641bc3…` 对应的模型文件在仓库内不存在（`grep -rl` 仅命中注释本身），因此该哈希**不可复现**；③ 的行为化断言即为其替代证据。

---

## 1. 交付物

| # | 交付 | 路径 | 命令 |
|---|---|---|---|
| ① | 转移表穷举（13×15=195 格 + 守卫分支 + attempts 单调） | `test/machine/transitions.test.ts` | `node --import tsx --test test/machine/transitions.test.ts` |
| ② | 不变量路径搜索（DONE 必过 commit/index_ok/match_ok；FAILED/CANCELLED/PAUSED 必过 stop） | `test/machine/invariants.test.ts` | `node --import tsx --test test/machine/invariants.test.ts` |
| ③ | 数据模型约束（唯一键/局部唯一/PK/IFNULL/外键 CASCADE/RESTRICT） | `test/schema/constraints.test.ts`、`test/schema/fts_trigram.test.ts`、`test/schema/_db.ts` | `node --import tsx --test test/schema/*.test.ts` |
| ④ | AC1–AC12 冒烟（每条 AC 一进程；服务未就绪打印 PENDING + 就绪后命令） | `test/smoke/ac01..ac12*.ts`、`test/smoke/all.ts`、`test/smoke/_lib.ts` | `node --import tsx test/smoke/all.ts` |
| 附 | 缺陷最小复现 | `test/repro/scan-defects.mjs`、`test/repro/missing-status.mjs` | 见 §5 |
| 附 | 原始证据 | `docs/verification/evidence/*`、`logs/verifier-*.log` | — |

验收仪器全绿（含 core-identify/core-content 的用例）：

```
$ node scripts/test.mjs
# tests 182   # suites 19   # pass 182   # fail 0   EXIT=0   (logs/verifier-testmjs-final2.log)

$ npx tsc --noEmit
EXIT=0（0 error；verifier 曾引入 1 个 TS2339，已修，logs/verifier-tsc2.log）
```

---

## 2. ① 转移表穷举（`test/machine/transitions.test.ts`）

原始输出：`docs/verification/evidence/verifier-machine-run2.log`（两文件合计 # tests 34 / # suites 8 / # pass 34 / # fail 0）

- **全矩阵逐格断言**：13 状态 × 15 事件 = 195 格；期望矩阵在测试内**手写转写**（不 import 实现反推）。已定义 (state,event) 格子 = 20，未定义 = 175，`TRANSITIONS.length == 21`（failed+retry 占守卫/默认两行）。
- **守卫分支**：`failed+retry` 在 attempts=0..4 → `queued`；attempts=5/6/99 → `abandoned`；attempts=4 与 5 必须不同（分支唯一）。
- **attempts 单调/上限**：穷举 (state, attempts) 可达集 → attempts 只增；越限只出现在 `abandoned`；最大可达 attempts = MAX_ATTEMPTS+1 = 6（守卫为假的那次 retry 仍推进计数后落终态）。retry 是唯一推进 attempts 的事件。
- **结构不变量**：终态无出边；6 条 stop 边全汇 releasing；`IN_FLIGHT_STATES` 9 个（含 paused）。
- 防退化对照：`queued+start→resolving`（正例） vs `queued+commit→null`、`done+start→null`（反例）；"守卫只作用于 failed+retry"用 attempts=0 vs 999 全矩阵比对。

## 3. ② 不变量路径搜索（`test/machine/invariants.test.ts`）

方法：BFS over `(状态, 已见事件掩码)`（掩码单调增 ⇒ 可达集是闭包、**穷举而非抽样**，可达节点 233），有序性另用进度自动机 `[commit, index_ok, match_ok]` 再跑一遍。

- I1：`done` 的**每一条**路径必含 commit+index_ok+match_ok+succeed，且顺序进度必须 3/3。见证：`start→resolve_ok→fetch_ok→commit→index_ok→match_ok→succeed`。
- I2：`failed`/`cancelled`/`paused`/`abandoned` 的每条路径必含 stop。见证：`stop→fail`、`stop→hold`。
- 更正记录（诚实性）：初版我曾断言"done 路径不得含 stop/fail"——**该断言被证伪是正确的**：`stop→releasing→fail→failed→retry→queued→…→done` 是机器允许的恢复路径。已改为断言该恢复路径存在 + 最短路径不含 stop/fail。
- 反例对照（证明检查器非恒真）：到 `releasing` 存在不含 fail 的掩码；到 `fetching` 存在不含 commit 的掩码；`failed` 的掩码必含 fail。

## 4. ③ 数据模型约束（`test/schema/constraints.test.ts` + `fts_trigram.test.ts`）

原始输出：`docs/verification/evidence/verifier-schema-run3.log`（# tests 43 / # pass 43 / # fail 0）
方法：better-sqlite3 临时库 + `db.exec(schema.sql)`，`foreign_keys=ON`。每条约束都成对（正例+负例）：

| 约束 | 正例（必须通过） | 负例（必须失败，实测 SQLite 错误码） |
|---|---|---|
| items(source_site,source_item_id) 局部唯一 | 3 行 `(local,NULL)` 共存；同号不同 site 通过 | 重复 `(booth,'6115428')` → `SQLITE_CONSTRAINT_UNIQUE` |
| assets.path_norm 唯一 | 不同 path_norm 多行；root_id/item_id 有效 | 重复 path_norm → UNIQUE；无效 root_id/item_id → FOREIGNKEY |
| jobs 在飞局部唯一 | done/failed 后可再建同 kind；item_id NULL 多行；不同 kind 并存 | 同 (item,kind) 两个在飞 → UNIQUE；9 个在飞状态逐一验证（含 **paused**）；终态不占位 |
| item_avatars 复合 PK | 同 item 不同 avatar / 同 avatar 不同 item | 重复 (item_id,avatar_id) → `SQLITE_CONSTRAINT_PRIMARYKEY` |
| asset_avatars IFNULL 前缀唯一 | NULL 与 'Assets/x' 并存；同 (asset,avatar) 两个不同非空前缀并存 | 重复 NULL-NULL → UNIQUE；**NULL 与 '' 视为同一前缀** → UNIQUE；重复非空前缀 → UNIQUE |
| tags(IFNULL(namespace,''),name)、item_tags PK | namespace NULL 与 'booth' 并存 | '' 与 NULL 冲突 → UNIQUE；重复 item_tag → PRIMARYKEY |
| FK CASCADE | 删 item → images/assets/jobs/item_avatars/archive_entries/asset_avatars/job_events/source_snapshots 8 表清零；删 avatar → 3 表清零 | — |
| FK RESTRICT | 置 cover_image_id=NULL 后可删图；清 project_imports 后可删 asset/root | 删被引用图/根/asset → `SQLITE_CONSTRAINT_TRIGGER`（SQLite 对 RESTRICT 报 TRIGGER，非 FOREIGNKEY；已按实况记录） |
| 反例缺口自证 | `PRAGMA foreign_keys=1` | `foreign_keys=OFF` 后同一删除成功 → 证明上一条失败来自 FK 而非别的原因 |
| FTS5 trigram 中日文 | `ヌカち`（中段非前缀）、`マヌカ`、`ちゃん用`（跨列命中 1+2）、`乃ちゃ`、`対応1`、`hinano` 命中原行；大小写不敏感 | 不存在词 `qwerty`/`ミルフィ` 不误命中；**2 字符 `雪乃` 在 FTS 层 0 行**（阈值事实），同数据 `items LIKE '%雪乃%'` 命中 1 行 ⇒ 证明 0 来自分词阈值而非数据缺失 |
| FTS 维护路径 | 内容存储型：列可读回；`DELETE FROM items_fts WHERE rowid=…` 后不再命中 | 未闭合引号 MATCH → 抛错（不静默返回空集） |

## 5. ④ AC 冒烟结果（服务 :7317）

命令：`AV_SMOKE_TIMEOUT_MS=60000 node --import tsx test/smoke/all.ts`；单条：`node --import tsx test/smoke/acNN-*.ts`
原始日志：`docs/verification/evidence/verifier-smoke-all-1.log`、`verifier-smoke-targeted.log`、`verifier-ac03-run3.log`

| AC | 结果 | 原始证据（摘要） |
|---|---|---|
| AC1 扫库建档/0 错配 | **FAIL（开放缺陷 D7）** | job16 done，135 items；抽检 10 条自动匹配，7 条 `canonical_url`/`source_url` **双空** → 无法回溯商品页 |
| AC2 链接建档 | PASS | job3 done；item#4 title/作者/分类/价格齐；origin='booth' 图 3 张且全部落盘 |
| AC3 unitypackage | PASS | asset#136 MANUKA.unitypackage → **165 GUID**、2ms、类型统计 Anim78/Tex34/Material10/…；调用前后无 Unity 进程 |
| AC4 扫描幂等 | PASS | 两次 scan 后 Δitems=0 Δassets=0（135→135→135）。注：本轮 18:30:54 曾复现 Δitems=+2/次（缺陷 D2），18:33 起不再复现 |
| AC5 搜索 | PASS | Shinano 4ms / ミルフィ 2ms / milky 2ms 均 <1s；不存在词 0 条（反例对照） |
| AC6 崩溃恢复 | **PENDING** | 只读检查通过（0 僵尸在飞、0 .part）；kill -9 自动化需 `AV_SMOKE_SERVER_PID`+`AV_SMOKE_SERVER_CMD`，或按脚本打印的手动 4 步 |
| AC7 缺文件 | **FAIL（开放缺陷 D6）** | present → 删文件重扫 → **仍 present**（期望 missing）→ 恢复 → present；`test/repro/missing-status.mjs` verdict.pass=false |
| AC8 列表性能 | **PENDING** | 当前 135 条 < 1000；用 `AV_SMOKE_SEED=1` 现场造数或先建 1000 条库后重跑 |
| AC9 core 单测 | PASS | `node scripts/test.mjs` → # tests 180 / # pass 180 / # fail 0 / EXIT=0 |
| AC10 多头像交叉校验 | PASS | declared>0 的条目 declared vs `avatars.length` 均可观测，无「declared≥3 却抽 0」 |
| AC11 avatar 快筛 | PASS | A=#2 Milfy(3 条) 全部含 A；all=0 ≤ any=5，all 结果同时含 A、B |
| AC12 别名归一 | PASS | マヌカ/まぬか/Manuka/MANUKA → 同一 avatar#1；冲突别名加给 avatar#23 → **409 CONFLICT** |

## 6. 缺陷清单（按严重度）

| ID | 状态 | 严重度 | 摘要 | 最小复现 | 证据 |
|---|---|---|---|---|---|
| **D6** | **OPEN** | 高 | 磁盘文件删除后重扫，`assets.status` 仍为 `present`，不翻 `missing`（AC7 判据直接违反） | `node test/repro/missing-status.mjs` → `verdict.pass=false`（initial/afterDelete/afterRestore 均 present） | `docs/verification/evidence/missing-status.json`、`verifier-repro-d6.log`、`verifier-ac07-run2.log` |
| **D7** | **OPEN** | 中 | 自动匹配条目只写 `source_site/source_item_id`，不写 `canonical_url/source_url`（7/10 抽检双空）→ 无法回溯、无法做更新检查基线 | `node --import tsx test/smoke/ac01-scan.ts` → "错配明细 item#73 sid=170902 不在 url: " | `verifier-smoke-targeted.log`（AC1 段） |
| **D5** | **OPEN** | 中 | 单个不可解析压缩包让**整个 scan 作业**失败（`cannot read zip …: Bad archive`），且失败原因只写在 `job_events.detail`，`jobs.error` 为 `NULL` → 客户端看到"failed 但无原因" | `node test/repro/scan-defects.mjs`（D1 段：job7 failed，events detail=Bad archive，jobs.error=null） | `evidence/scan-defects.json`、`verifier-repro-scan.log` |
| **D1** | 已修复（本轮内） | 高 | 真实库扫描作业失败：`repo.touchAsset is not a function`（TypeError，indexing 阶段） | 18:30:03 job2 events；18:33 起同命令 job16 done、135 items | `evidence/scan-defects.json`（历史）、`verifier-smoke-targeted.log`（现状） |
| **D2** | 已修复（本轮内） | 高 | 每次 scan 新建 2 个目录分组 item（`FadeOut_System_Ver2.0+ (1)`、`衣服`），旧 item 留 0 assets；items 10→12→14，出现 5 组同名重复条目 | `node test/repro/scan-defects.mjs`（D2 段，18:30:54） | `evidence/scan-defects.json`；18:33 AC4 Δitems=0 |
| D4 | 待补验 | 低 | `jobs.error` 与 `job_events.detail` 不一致（见 D5 同因） | 同上 | 同上 |

> D1/D2 的"已修复"判定基于同一命令在 18:33 的复跑（服务侧代码在 18:30–18:33 之间被 lead/core 更新）；因无 git，无法钉到具体 commit，结论仅覆盖当时运行的进程镜像。

## 7. 度量定义与正/反例对照（纪律 #6）

- **"错配"（AC1）**：自动匹配条目的 source_item_id 必须出现在 canonical_url/source_url 中，且 id_confidence≥0.6；id_confidence<0.8 必须 status='inbox'。正例：3/10 条目 URL 含号；反例：item#73 sid=170902 两 URL 均空。**替代解读**：若产品决定"URL 可后补"，则本判据需 lead 明确降级为警告——当前按已批准 AC1"0 错配"执行。
- **"命中正确条目"（AC5）**：结果标题命中词或其别名集合（milky↔Milfy↔ミルフィ；Shinano↔しなの）。正例：milky→#? 标题含 Milfy；反例：不存在词 zzqqxx 必须 0 条。
- **"幂等"（AC4）**：两次 scan 前后 assets/items 计数差 = 0。正例：135→135；反例：D2 复现时 10→12（+2）。
- **"不启动 Unity"（AC3）**：`ps -eo comm` 精确匹配 `Unity|Unity Hub|UnityPackageManager` 在调用前后均为空（早期用 `pgrep -fl` 会自-match，已修）。
- **不变量检查器非恒真**：见 §3 的三条故意为假命题取证伪。

## 8. 遗留 / 未覆盖

1. AC6 未经真实 kill -9（只读部分通过）；AC8 未在 1000 条数据下测。
2. 转移表模型的声明哈希（SM/DM）无仓库内模型文件，不可复现；①② 提供行为等价证据。
3. 本报告不覆盖 `apps/web/**`（web-ui 写作用域）。
4. 服务进程在观测期间被多次重启（AC1–AC8 一轮中曾短暂不可达），表内状态取自最终定向复跑。
