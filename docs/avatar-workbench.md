# Avatar 素材工作台（v0.7.0）

> 一句话：**按 Avatar 挑素材 → 看证据和打包策略 → 勾进导入清单 → 生成导入计划 → 提交执行 → 逐单元看结果。**
> 混合包整包导入，**绝不拆包**。
>
> 本文是用户手册 + 契约说明。实现位置：
> `apps/server/src/services/structure.ts`（单元识别 / policy / 计划 / 执行）、`packages/core/src/structure.ts`
> （`decidePolicy` / `detectUnitAvatars` / `relationCandidates`）、`apps/web/src/components/AvatarWorkbench.tsx`（面板）。

---

## 1. 它解决什么问题

扫库只回答到「**一个压缩包 = 一个资产**」。但真正要导入 Unity 的时候，你关心的是更细的一层：

- 这个包里**有没有**我的模型能用的那个 `.unitypackage`？
- 它是**独立包**，还是**混合包**（一个包里塞了好几个模型的资源）？
- 包里的证据到底是什么（文件名 / 包内路径 / 商品页声明 / 你手动确认的）？
- 它会往我的工程里**塞进什么别的东西**？

工作台就是把这层拆开：**资源单元（unit）** → **证据** → **策略（policy）** → **计划（plan）** → **执行（run）**。

---

## 2. 概念

| 概念 | 是什么 | 落在哪 |
|---|---|---|
| **资源单元 unit** | 一个可独立识别的导入单位：一个 `.unitypackage` 本体，或压缩包里的一层 `.unitypackage`（支持 zip 套 zip 的一层） | `asset_units`（唯一键 `asset_id + rel_path`） |
| **单元关系** | 单元之间的**建议**关系（伴生材质 / 可选变体）；只到 `probable`，永不自动 `confirmed` | `unit_relations` |
| **导入计划 plan** | 一次「用户确认后要导入哪个工程」的**快照**：逐单元记下原始路径 + 指纹 + precheck 结论 | `import_plans` + `import_plan_items` |
| **执行 run** | 计划的一次实际执行；每个单元一条独立状态，互不覆盖 | `import_runs` + `import_run_items` |

**关键约束**：计划与执行里的 `path` **永远指向原始资产**（整包 / 原容器），不指向任何筛选包、临时拆包或中间产物。

---

## 3. 用户操作

### 3.1 先让工作台识别单元

- 打开「素材工作台」或对某个条目点「分析」时，前端调 `POST /api/workbench/scan { itemId }` → **202 `{jobId, itemId, state}`**。
- 这是异步作业（`kind = structure`），同一条目重复点会被 jobs 的 `(item_id, kind)` 在飞唯一索引挡住 → 409 `CONFLICT`。
- 分析完才会出现单元；**分析失败不会伪造单元**：解析不完整 → `parse_state = partial/failed`，policy 落 `unknown_structure`。
- 发现/解析有硬预算（深度 ≤3、≤32 个内层归档、单包 ≤512MB、累计 ≤512MB、45s、条目 ≤1 万），超限标 `limited`。
- **一次补齐全部结构**：`POST /api/workbench/scan-all { onlyMissing: true }` → **202 `{ jobId, state }`**，
  只给**还没分析过**的条目排作业（已分析过的不重复扫）；实测 **37s 扫完 32 个条目**。
  前端拿到 jobId 后每 2s 轮询 `GET /api/jobs` 找这条 job，到 `done/failed/cancelled/abandoned` 就 toast 结果并**自动刷新** Avatar 计数与单元列表。

### 3.2 选 Avatar

- 列表来自 `GET /api/workbench/avatars?itemId=`，每个 Avatar 显示四类计数：
  `confirmed`（人工确认）/ `probable`（文件名·包内路径推断）/ `unknown`（未定）/ `mixed`（混合整包单元）。
- 计数就是这个 Avatar 名下的**单元数**，不是条目数。

### 3.3 筛选与看证据

筛选参数：`avatarId` / `policy` / `level` / `itemStatus` / `q` / `category` / `confirmedOnly`。
每张卡片显示：封面、名称、来源站 + 商品号 + 店铺、目标 Avatar、类型、`包名 › rel_path`、
**证据级别 + 摘要 + 来源**、**policy 文案**、`mixed` 时额外的「整包风险」徽章。

证据级别（`avatar_json[].level`）：

| 级别 | 含义 | 来源 |
|---|---|---|
| `confirmed` | 你手动确认过的适配 | `item_avatar` / `manual` |
| `probable` | 结构/路径推断 | 文件名、包内路径 |
| `unknown` | 没有可用证据 | — |
| `conflict` | 多处证据打架（只报告，不猜） | — |

### 3.4 加入导入清单

- 点卡片加入右侧「导入清单」（清单独立于「保存搭配」）。
- **同槽位互斥**：同一压缩包（`containerPath`）里的多个单元只能选一个——导入其中一个就等于导入整包；同一 item + 同一包名也不会重复。
- 清单里有 mixed 单元时，清单底部会立刻显示整包风险红条。

### 3.5 选 Unity 工程 → 生成导入计划

- 工程路径可**自动探测**（`GET /api/unity/status` 的 `editor.projectPath`，探测失败可手填）。
- **探测只自动跑一次**：打开工作台时调一次 `/unity/status`，之后只有手点「探测」才会再发请求（按钮会显示「探测中…」）。
  探测成功**静默**（不弹 toast），只有手动探测且没拿到工程路径/请求失败时才提示一句——避免每次重渲染都探测、刷日志。
- 若 `GET /api/workbench/avatars` 返回空列表，但 Unity 工程里认出了 Avatar（`projectAvatar`），左侧会**用这个头像兜底并选中**，
  同时提示「已用 Unity 工程里认出的 @xxx 兜底；点「扫描全部结构」补齐计数」。
- `POST /api/import-plans { unitIds, projectPath, includeSuggested }` → **201** 计划视图。
- 一次计划**只能属于同一个条目**：跨条目选单元会被后端拒绝（`INVALID_INPUT`）。想导多个条目就分别建计划。

### 3.6 看 precheck

计划生成时逐个单元校验，结果在 `precheck.units[]`：

| 字段 | 含义 |
|---|---|
| `changed` | 指纹与建计划时不一致（文件被替换/大小变了） |
| `fileExists` | 原始文件还在不在 |
| `policy` / `mixed` / `importable` | 该单元的策略与可导入性 |
| `status` | `pending` / `suggested` / `blocked` |
| `error` | 具体原因（指纹变了 / 文件不存在） |

计划状态：

| `plan.status` | 含义 | 能不能执行 |
|---|---|---|
| `ready` | 预检通过 | 可以 |
| `needs_confirmation` | 有 mixed / 有 suggested / 工程路径暂不可访问 | 需先 `confirm` |
| `blocked` | 有单元指纹变化或文件缺失 | **不能**（`PLAN_BLOCKED`） |
| `running` / `executed` / `failed` | 执行中 / 已执行 / 失败 | 不能重跑（要重新建计划） |

**suggested 必须你自己勾**：`includeSuggested` 带进来的伴生单元状态是 `suggested`，前端默认**不勾选**；
你勾了才会进 `confirm` 的 `unitIds`，`confirm` 把它改成 `pending`。

### 3.7 确认 → 执行

1. `POST /api/import-plans/:id/confirm` —— 人工确认（suggested → pending，`user_confirmed = 1`，状态回到 `ready`）。
2. `POST /api/import-plans/:id/execute` —— **202 `{ jobId, planId }`**（Job 化，`kind = import`）。
   - 已有在飞执行 → 409 `CONFLICT`（带 `jobId`）；
   - blocked / 未确认的 needs_confirmation / 已执行过 → 409。
3. 前端轮询 `GET /api/import-plans/:id` 与 `GET /api/import-runs/:id` 显示逐单元状态。
   **不要假设 execute 同步返回 run**——run 是执行过程中才建出来的。计划视图里的 `run_id` / `latestRun` 一旦出现，就据此拉 run。
4. **前置失败也会留下可审计的 failed run**：Unity 离线、工程路径不匹配、指纹变化等发生在真正导包之前的错误，
   会写一条 `status = failed` 的 run（每个单元一条 `failed` run_item，`detail.phase = "preflight"`），
   同时计划视图给出 `lastError: { code, message, phase }`。**不会出现**「计划 failed 但看不到原因」的情况。

### 3.8 逐单元状态

| 状态 | 含义 |
|---|---|
| `importing` | 正在校对/暂存并调用 Unity 导入 |
| `import_command_completed` | Unity **接受了命令**（≠ 成功） |
| `verifying` | 等 Unity 落盘后回读控制台 + 抽样 GUID |
| `verified` | 抽样 GUID 命中且控制台无 error |
| `partial_success` | 命令完成但校验没过（GUID 未命中 / 有控制台 error） |
| `failed` | 这一单元导入失败（错误见 `error` / `detail_json`） |

run 级状态：`running` / `verified` / `partial_success` / `failed`（全成功才 `verified`；全失败才 `failed`）。

---

## 4. 整包策略 A/B

混合包（一个 `.unitypackage` 里装了多个模型的资源）是这类工具的常见坑。只有两种做法：

| | **策略 A：拆出筛选包**（不采用） | **策略 B：整包导入**（采用） |
|---|---|---|
| 做法 | 按 Avatar 把包内资源挑出来重新打一个 `.unitypackage` | 直接把**原始整包**交给 Unity |
| 字节 | 变了（重打包） | 不变 |
| GUID / 依赖 | 重打包会改 GUID、丢 `.meta` 依赖，材质/预制体引用可能断 | 原样保留 |
| 可复现 | 每次重打包结果可能不同，无法用指纹校验 | 指纹（size + mtime + sha256 前 8 + 单元大小）可校验 |
| 责任边界 | 相当于替原作者改包 | 只做搬运，不改内容 |
| 代价 | — | **包里别的 Avatar 资源也会一起进工程** |

**所以本项目的硬约束是：**

1. `mixed_unitypackage` 的 plan/execute **永远引用原始整包**，绝不生成筛选包 / 临时拆包；
2. 计划与清单里**显式标注整包风险**，文案固定为「混合整包：将完整导入，其他 Avatar 的资源也可能被一并导入」；
3. 含 mixed 的计划一定是 `needs_confirmation`，必须人工 `confirm` 后才执行；
4. 导入后工程里多出来的东西由**你在 Unity 里自己清理**——AssetVault 不删、不改你的工程文件。

> 注意区分：**ZIP 里装了多个 `.unitypackage`** 是「多独立包容器」（`multi_package_container`），
> 这是**逐包可导**的，不算混合包；**一个 `.unitypackage` 里混了多个模型**才是 `mixed_unitypackage`。

---

## 5. policy 判定（`decidePolicy`）

| policy | 判定 | 可导入 |
|---|---|---|
| `single_unitypackage` | 单个 `.unitypackage`，且没有多模型证据 | ✅ |
| `mixed_unitypackage` | **≥2 个不同模型的证据**，或显式 `mixedConfirmed` | ✅（整包） |
| `multi_package_container` | 容器里多个内层 `.unitypackage`（外层 ZIP 本身**不构成** mixed 理由） | ❌（逐包建单元） |
| `unknown_structure` | 解析不完整（partial/failed）、或判不出来 | ❌ |

纪律：**不猜**。证据不足就是 `unknown`，解析不完整就是 `unknown_structure`；
关系建议只输出 `probable`，`confirmed` 需要 README/GUID 级证据（本模块没有，故永不输出）。

---

## 6. HTTP API

| 方法 | 路径 | 入参 | 出参 | 说明 |
|---|---|---|---|---|
| POST | `/api/workbench/scan` | `{ itemId, refresh? }` | **202** `{ jobId, itemId, state }` | 异步分析容器的资源单元（`kind = structure`） |
| POST | `/api/workbench/scan-all` | `{ onlyMissing?: boolean }` | **202** `{ jobId, state }` | 批量补结构分析（默认只补没分析过的条目；实测 37s / 32 条目） |
| GET | `/api/workbench/avatars` | `?itemId=`（可选） | `[{ avatar: {id,name}, counts: {confirmed, probable, unknown, mixed} }]` | 按 Avatar 聚合单元证据计数（**裸数组**） |
| GET | `/api/workbench/units` | `?itemId=&avatarId=&policy=&level=&itemStatus=&limit=` | `[{ id, assetId, itemId, relPath, format, kind, name, size, fingerprint, policy, importable, mixed, parseState, parseError, avatars[], evidence, item, asset, updatedAt }]` | 单元视图（**裸数组**） |
| POST | `/api/import-plans` | `{ unitIds: number[], projectPath: string, includeSuggested?: boolean }` | **201** PlanView `{ plan, items, precheck, run_id, latestRun, lastError }` | 建计划（快照 + 指纹 + precheck） |
| GET | `/api/import-plans/:id` | — | PlanView（同上） | 计划详情（轮询用；`run_id` 出现后就去轮询 run） |
| POST | `/api/import-plans/:id/confirm` | — | PlanView | 人工确认（suggested → pending） |
| POST | `/api/import-plans/:id/execute` | — | **202** `{ jobId, planId }` | 建 import job（Job 化，不返回 run） |
| GET | `/api/import-runs/:id` | — | `{ run, items }` | 执行进度与逐单元状态 |

错误码：

| code | HTTP | 触发 |
|---|---|---|
| `INVALID_INPUT` | 400 | unitIds 为空 / projectPath 为空 / 单元不存在 / 单元不可导入 / **跨条目** |
| `NOT_FOUND` | 404 | 计划或 run 不存在 |
| `PLAN_BLOCKED` | 409 | 计划被 precheck 阻断（指纹变化 / 文件缺失） |
| `CONFIRM_REQUIRED` | 409 | `needs_confirmation` 且未 `confirm` |
| `PLAN_NOT_EXECUTABLE` | 409 | 计划已 executed/failed/running，**不可重放** |
| `CONFLICT` | 409 | 已有在飞执行作业（带 `jobId`）/ 同条目已有结构分析作业 |
| `UNITY_UNAVAILABLE` | 409 | 执行时探测不到打开的 Unity 编辑器 / 工程路径不匹配（**会落 failed run + `lastError`**） |

---

## 7. 限制与已知问题

- **Unity 实导未做端到端验证**：链路（staging → `AssetDatabase.ImportPackage` → 控制台回读 → GUID 抽样）已实现且有单测，
  但本轮**没有连真实 Unity 编辑器跑过实导**。`verified` 的判定是「抽样 ≤20 个 GUID 在工程 `.meta` 里命中（扫 ≤8000 个文件）+ 控制台无 error」，
  **不等于肉眼验收**；`partial_success` 同理，可能只是抽样没命中。
- **一次计划只能属于同一个条目**（后端硬校验 `itemIds.length === 1`）；跨条目请分别建计划。
- **执行不可重放**：同一计划执行过就不能再 execute（外部副作用不自动重试）；要重跑请重新建计划。
- **指纹口径**：`size:mtime:sha256前8:单元大小`。任一变化 → `blocked` / execute 拒绝，绝不按旧快照导入。
- **发现与解析预算（超限只标 `limited`，不伪造完整结果）**：
  · 嵌套容器发现：深度 **≤3**、最多 **32** 个内层归档、单次 listing ≤5000 条；
  · 单包 **≤512MB**、累计解压 **≤512MB**、时间 **≤45s**；
  · 单元解析（读 `.unitypackage` 内容）：单包同上 **≤512MB**、条目 **≤1 万条**资产、最多 64 个包。
- **7z / rar 内层缩略图不抽**：单元识别与缩略图无关；7z/rar 里图片仍不生成缩略图。
- **混合包导入后需要你在 Unity 里清理**：工具只保证「导入的是原始整包」，不替你删工程里多出来的资源。
- **关系建议只是建议**：`unit_relations` 只到 `probable`，不会自动进计划；要进计划必须你勾 `includeSuggested` 或手动选。
