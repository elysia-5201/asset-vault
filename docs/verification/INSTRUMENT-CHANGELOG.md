# 验收仪器变更记录（记录 md5 + 语义未放宽结论）

> 纪律：验收脚本（scripts/acceptance-*.mjs、scripts/test.mjs、bench-*）的每次改动都必须在此登记，
> 写明「旧 md5 → 新 md5」「为什么改」「语义是否放宽（必须给出逐条核对）」「改后实测输出」。
> 未登记的仪器改动，其验证结论视为无效。

## 2026-10-20 · scripts/acceptance-pipeline.mjs —— [10] schema 版本断言跟随 SCHEMA_VERSION

- **旧 md5**：`8d72669e1d108010913ae70594d0afd4`
- **新 md5**：`44eb78fa9e435c2a40b2ece4951b241e`
- 触发：`SCHEMA_VERSION` 已升到 **6**（v6 增加 jobs 租约/心跳列与 `cache_entries.weak`），
  而 [10] 仍硬编码 `schema_meta.version === "5"` → 在 v6 上必然 1 条失败。

### 改动（仅 3 处，均为 [10] 与注释）
1. `import { openDatabase } from "../apps/server/src/db/migrate.ts"` → 追加 `SCHEMA_VERSION`。
2. `check("schema_meta.version=5", String(...) === "5")` →
   `check("schema_meta.version=" + SCHEMA_VERSION, String(...) === String(SCHEMA_VERSION))`。
3. 头注释「schema v5 迁移」→「schema 版本与三表存在」（纯文档，无断言）。

### 语义未放宽（逐条核对）
- **仍是严格相等**（`===`），**没有**改成 `>= 5` 之类弱断言；若 `migrate()` 写入值与 `SCHEMA_VERSION` 不一致，仍然失败。
- `SCHEMA_VERSION` 与建库用的 `openDatabase` 来自**同一模块**，断言的是"这个库的版本 = 当前代码的版本"，强度与原先"=5"同构。
- 「三张表存在」（`index_tasks` / `pipeline_events` / `cache_entries`）断言**原样保留**，未删未改。
- 其它 35 条断言、夹具、阈值、执行顺序**零改动**。

### 改后实测
```
$ node --import tsx scripts/acceptance-pipeline.mjs
[10] schema v6
  ✓ schema_meta.version=6
  ✓ 表存在: index_tasks
  ✓ 表存在: pipeline_events
  ✓ 表存在: cache_entries
PASS 36 passed / 0 failed        (EXIT=0)
```
原始输出：`logs/acceptance-pipeline-hotfix.log`；md5 记录：`docs/verification/evidence/v061-perf/acceptance-pipeline.md5.{before,after}.txt`。

### 同脚本的未决仪器问题（**本轮未授权，未改**）
- `scripts/acceptance-pipeline.mjs:75` 用 `a.file.path.split("/").pop()` 取文件名；Windows 上 `walkCandidates` 返回反斜杠路径 →
  `assets["normal.zip"]` 为 undefined，第 80 行 TypeError。V0.6.1-WINDOWS.md §5 F1 已记录，修法 1 行（`path.basename` 或 `split(/[\\/]/)`），
  **需 lead 授权后方可改**，改后同样需要在此登记。

## 2026-10-20 · scripts/acceptance-pipeline.mjs —— F1 Windows 路径分隔符（lead 已授权）

- **旧 md5**：`44eb78fa9e435c2a40b2ece4951b241e`
- **新 md5**：`95d56270932cf9ee9d4048e15b99b4bc`
- 改动（1 行实现 + 1 行注释）：
  `assets[a.file.path.split("/").pop()]` → `assets[String(a.file.path).split(/[\\/]/).pop()]`。
- 触发：Windows 上 `walkCandidates` 返回反斜杠路径，`split("/")` 取不到文件名 → `assets["normal.zip"]` undefined → 第 80 行 TypeError（WINDOWS §5 F1）。
- **语义未放宽**：
  - 36 条断言零改动；只改"从路径取 basename"的实现。
  - 行为等价性实测：`/tmp/x/normal.zip` 与 `C:\\tmp\\x\\normal.zip` 都得 `normal.zip`；POSIX 下与旧实现完全一致（键名不变）。
  - 同时接受 `/` 与 `\\`，不修改任何阈值/夹具/执行顺序。
- 改后实测（WSL）：见下。

### 复跑结果（WSL，2026-10-20）
```
$ node --import tsx scripts/acceptance-pipeline.mjs
PASS 36 passed / 0 failed
```
原始输出：`logs/acceptance-pipeline-f1.log`；md5：`docs/verification/evidence/v061-perf/acceptance-pipeline.md5.f1-after.txt`。
Windows 侧：**需 win-verify 用新文件重跑**（本机无法执行 Windows Node）。
