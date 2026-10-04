# AssetVault 验收记录（AC1–AC12）

日期：2026-10-04 · 执行：lead（最终验证）+ verifier（独立复核）
被测版本：`contracts.ts` md5 见下，`scripts/test.mjs` md5 `18e549c0caa5171c4e0782fa488453ae`（测量期间未改）

## 汇总

| AC | 判据 | 结果 | 证据 |
|---|---|---|---|
| AC1 | 扫库建档、商品号自动匹配零错配 | **PASS** | `logs/acceptance-all.log` MAIN/AC1；抽检 /api/items?site=booth 的 sourceUrl 全非空（D7 修复后） |
| AC2 | 链接建档 ≥2 张官方图 + 标题/作者/分类/标签/价格，离线可看 | **PASS** | 6494376 imgs=8 / 8183383 imgs=12 / 6115428 imgs=3，tags 10–22 条，图落盘于 `data/media/<itemId>/` |
| AC3 | unitypackage 免 Unity 解析（MANUKA 165 GUID） | **PASS** | `GET /api/assets/12/unitypackage` → total=165，byType: AnimationClip 78 / Texture2D 34 / Material 10 / Prefab 2 / AnimatorController 4 / Asset 7 / Model 1 / other 29；core 侧独立仪器（GNU tar）交叉一致 |
| AC4 | 重复扫描幂等（不重复建 assets/items） | **PASS** | 二次扫库 delta assets = 0，delta items = 0 |
| AC5 | 中日文子串搜索（Shinano/ミルフィ/milky/しなの） | **PASS** | 四组查询均命中正确条目；URL 编码后无 4xx |
| AC6 | kill -9 后重启：无锁泄漏、无 .part、作业回收 | **PASS** | `scripts/ac06-crash.sh`：kill 前 state=resolving（在飞）→ kill 后 DB 仍 resolving、0 个 .part → 重启后 job_events 出现 `resolving -> queued [recovered] service restart`，随后重新 start |
| AC7 | 磁盘文件删除 → missing；恢复 → present | **PASS** | `scripts/acceptance-ops.sh`：present → (删文件+重扫) missing → (恢复+重扫) present |
| AC8 | 1000+ 条目列表首屏 <1s | **PASS** | 播 1000 条合成条目后：`/api/items?limit=50` 2.9 ms；`?q=Shinano` 2.3 ms |
| AC9 | core 纯函数单测全绿（真实 fixture） | **PASS** | `node scripts/test.mjs` → 184/184 pass（19 套件），含真实 BOOTH JSON、真实 zip/7z/rar、MANUKA.unitypackage |
| AC10 | 多头像条目抽取 + 与声明数交叉校验 | **PASS** | 6494376「【6Avatars】」→ 6 命中（Airi/Chocolat/Kanata/Manuka/Shinano/Sio）且 declared=6；`[19 Avatars]` → 10 命中 + declared=19（差值即"还差 9 个待补"） |
| AC11 | 按 avatar 快筛（ANY/ALL） | **PASS** | `?avatar=<Manuka>` total=7（干净库 6）；`?avatar=Manuka,Milfy&avatarMatch=all` total=2 |
| AC12 | 别名归一 + 冲突不静默合并 | **PASS** | マヌカ/まぬか/Manuka/MANUKA 归一到同一 avatar；重复别名 → `409 CONFLICT 别名已被 Manuka 占用（待确认，不静默合并）` |

## 独立验证（verifier，task-4）

- 转移表 13×15=195 格**逐格**断言（20 格已定义 + 175 格 null）：`test/machine/transitions.test.ts` 34/34 pass
- 不变量路径**穷举**（(state, seen-events) 掩码 BFS，233 节点）：DONE 必过 commit/index_ok/match_ok；FAILED/CANCELLED/PAUSED 必过 stop
- 数据模型约束（真实临时库跑 schema.sql，正/负例成对）：局部唯一、IFNULL 唯一、CASCADE/RESTRICT、FTS5 trigram 中段命中与 2 字符阈值 —— 43/43 pass
- 详见 `docs/verification/TASK4-VERIFICATION.md` 与 `docs/verification/evidence/`

## verifier 报出的缺陷与处置

| 编号 | 严重度 | 结论 | 处置 |
|---|---|---|---|
| D1 `repo.touchAsset is not a function` | 高 | 已修 | 补 `Repo.touchAsset`（lead） |
| D2 重复扫描重复建目录分组条目 | 高 | 已修 | 改为"一压缩包一条目 + 按物理路径复用条目"（lead） |
| D5 坏包令整个 scan 失败且 `jobs.error` 为 NULL | 中 | 已修 | 逐资产 try/catch + `failed` 时写 `jobs.error`（lead） |
| D6 磁盘文件删除后 `assets.status` 不翻 missing | 高 | 已修 | 扫库后"有界深度内未再出现 → missing"（lead），AC7 复测 PASS |
| D7 自动匹配条目 `canonical_url/source_url` 双空 | 中 | 已修 | 自动匹配时写回 `https://booth.pm/ja/items/<id>`（lead） |

## 原始日志索引

- `logs/acceptance-all.log` —— AC 冒烟（ops + main 两段）
- `logs/acceptance-ops-3.log` —— AC7 / D5 / AC6（HTTP 视角）
- `logs/ac06-run1.log` —— AC6 真·kill -9（直接读 DB 取证）
- `logs/final-test-run.log` —— 184/184 单测
- `logs/verifier-*.log`、`logs/content-*.log`、`logs/core-identify-*.log` —— 各成员自测原始输出
