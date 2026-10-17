# AssetVault HTTP API（FROZEN v1）

Base: `http://127.0.0.1:7317/api`。所有响应 JSON；错误：`{ "error": { "code": AppErrorCode, "message": string } }` + 对应 HTTP 状态
（400 INVALID_INPUT / 404 NOT_FOUND / 409 INVALID_TRANSITION|CONFLICT / 502 UPSTREAM_ERROR / 401 LOGIN_REQUIRED）。

## 条目
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, version, dbPath, roots, counts}` |
| GET | `/items?q=&avatar=&avatarMatch=any|all&ownedOnly=&site=&status=&tag=&container=&imported=1|0&sort=updated|title|size&limit=&offset=&catIds=&catMatch=any|all&uncategorized=1&pendingCategory=1&tags=&tagsMatch=any|all&favoriteOnly=1` | `{total, items: ItemCard[]}`；`q` 为 FTS5 trigram 子串（<3 字符回退 LIKE），`avatar` 支持逗号分隔多值；`catIds`/`tags` 支持逗号分隔与重复键（见「物品分类」「分类体系 v3」） |
| GET | `/items/:id` | `ItemDetail`（item/images/assets/avatars/tags/updates） |
| POST | `/items` `{title, sourceUrl?, notes?}` | 手动建条目 |
| PATCH | `/items/:id` `{title?, status?, notes?, rating?, favorite?, shopName?, author?, categoryName?, tags?: string[]}` | `tags` 为**全量替换**；返回更新后的 ItemDetail |
| POST | `/items/:id/tags` `{tags: string[]}` | 追加标签 → ItemDetail |
| DELETE | `/items/:id/tags/:tagId` | 删除单个标签 → ItemDetail |
| POST | `/items/:id/images/reorder` `{imageIds: number[]}` | 按数组顺序写 position → ItemDetail |
| DELETE | `/items/:id` | 软删 → status=trashed |
| POST | `/items/:id/restore` | 回收站恢复 |
| POST | `/items/:id/images` `{paths?: string[], url?: string, role?, origin?}` | 加图（本地文件或 URL） |
| DELETE | `/items/:id/images/:imageId` | 删图 |
| POST | `/items/:id/images/:imageId/cover` | 设为封面 |
| POST | `/items/:id/assets` `{path}` | 挂本地文件/目录（自动识别容器，登记到 assets） |
| POST | `/items/:id/avatars` `{avatarIds: number[], match?: AvatarMatch}` | 手工标注适配模型 |
| DELETE | `/items/:id/avatars/:avatarId` | |
| POST | `/items/:id/check-update` | 起 check_update 作业 → `{jobId}` |
| GET | `/items/:id/duplicates?min=0.9&limit=20&rescan=1` | 该条目的重复资产 → `{itemId, min, matches: DuplicateMatch[]}`（见「去重」） |
| GET | `/items/:id/related?min=0.6&limit=10` | 疑似同商品（模型包/材质包/DLC 分开打包）→ `{itemId, min, matches: [{itemId, title, score, level, shared, reason, assetCount, imageCount}]}`（见「疑似同商品」） |

## 资产 / 内容
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/assets/:id` | AssetRow + 该资产的 avatar 关联 |
| GET | `/assets/:id/tree` | `{container, entries: ArchiveEntry[]}`（zip/7z/rar 按需列目录并缓存） |
| GET | `/assets/:id/unitypackage` | `{assets: UnityPackageAsset[]}`（不启动 Unity） |
| GET | `/assets/:id/entry?path=` | 从压缩包内直读单个文件（图片/文本预览） |
| POST | `/assets/:id/reindex` | 重列目录/重解析 → `{jobId}` |

## 去重（智能查重）
签名只读已缓存的压缩包目录（`archive_entries`）与 `.unitypackage` GUID 清单（`unitypackage_assets`），落进 `asset_signatures`（一行/资产）；索引成功时自动计算（失败静默，不影响索引结果）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/duplicates?min=0.9&limit=100&recompute=1` | 全库**跨条目**重复组 → `{min, groups: [{key, similarity, items: [{itemId, title, assetId, path, size, versionKey}]}]}`，按 similarity 降序、组内按 item id 升序 |
| POST | `/duplicates/recompute` | 重算缺失/stale 的签名（45s 预算，超预算的下次再补）→ `{scanned, updated}` |

**相似度口径（冻结）**：两边 SHA256 都非空且相等 → `similarity=1`、`level="exact"`、diff 全空；否则
`simEntries = (same + 0.5×changed) / (same+changed+added+removed)`（路径先小写/正斜杠/NFC 归一，同路径重复时取 size 最大），
`.unitypackage`（含压缩包内抽出的内层包）再算 `simGuids = |交集| / |并集|`，取两路最大值。
`similarity===1` 且 diff 全空 → `same-content`（内容一致、文件名或压缩方式不同），其余达到阈值 → `near`。
`diff` 的 added/removed/changed 每类最多 50 条，总数写在 `reason`（「新增 x / 删除 y / 修改 z」）。
条目端点返回的 `DuplicateMatch` 额外带 `otherTitle`/`otherPath`/`otherVersionKey`，便于 UI 直接显示。

## 疑似同商品（模型包 / 材质包 / DLC 分开打包）
把"同一商品被拆成多个包装"认出来（模型包 + 材质包 + 本体）。只比**标题 / 标签 / 包内一级条目名**里的产品名片段，
不比字节、不算哈希、不改任何数据；与「去重」的"同内容"是两件事。候选 = 所有非 `trashed` 条目（排除自己），
同商品但已在同一 collection 里的也照常返回（UI 自己决定显示什么）。
`entryNames` 取 zip/7z/rar 的**最外层**条目名（`entry_path` 不含 `/`）与 `.unitypackage` 的 `asset_path` 一级段。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/items/:id/related?min=0.6&limit=10` | → `{itemId, min, matches: [{itemId, title, score, level, shared, reason, assetCount, imageCount}]}`，按 score 降序、组外按 item id 升序，limit 默认 10 |

**口径（冻结）**：NFKC + 小写；emoji/符号/标点/空白一律当分隔符（保留中日文与字母数字，中日文↔ASCII 交界再切一刀）；
独立片段命中噪音词表（material/材质/マテリアル/texture/モデル/本体/readme/dlc/set…）或形如 `v2`/`1.2` 的版本片段 → 丢弃
（`25Avatars`/`007`/`伊吹` 这类保留）。两边候选 key **完全相等** → `score=1.0`、`level="same-product"`；
否则最长公共子串 L ≥ `max(3, ceil(0.6 × min(len_a, len_b)))` → `score=0.75`、`level="likely"`；都不过或低于 `min` → 不返回。
`shared` 为命中的共有片段（保留原文大小写、去重、按长度降序、最多 5 个），`reason` 是含最长命中片段的中文一句话
（命中来自包内文件时为「标题/包内文件共有「X」」）。

## 头像
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/avatars?q=&ownedOnly=1` | `{avatars: AvatarCard[]}`，AvatarCard 含 `itemCount`、`owned`、`aliases` |
| GET | `/avatars/:id` | 该 avatar 的条目列表（复用 items 查询参数） |
| POST | `/avatars` `{name, aliases?: string[], kind?, owned?, boothItemId?}` | |
| PATCH | `/avatars/:id` `{name?, kind?, owned?, coverPath?, boothItemId?}` | |
| POST | `/avatars/:id/aliases` `{alias, lang?, source?}` | 冲突 → 409 CONFLICT（进待确认，不静默合并） |
| DELETE | `/avatars/:id/aliases/:aliasId` | |
| POST | `/avatars/merge` `{fromId, intoId}` | 合并（把 item/asset 关联与别名迁到 intoId） |
| POST | `/items/:id/match-avatars` | 重跑头像匹配 → `{jobId}` |

## 导入 / 扫描 / 作业
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/booth/peek?url=` | 只读预览（不落库）：BoothItemMeta 摘要 |
| POST | `/import/url` `{url, downloadImages?: true}` | → `{jobId, itemId?}` |
| POST | `/import/paths` `{paths: string[]}` | → `{jobId}` |
| POST | `/scan` `{rootId?, path?, deep?}` | → `{jobId}` |
| GET | `/jobs?state=&limit=` | `{jobs: JobRow[]}` |
| POST | `/jobs/:id/run` | 手动推进一次 worker（调试用）→ `{processed, jobs}` |
| GET | `/jobs/:id/events` | JobEventRow[] |
| POST | `/jobs/:id/pause\|resume\|cancel\|retry\|abandon` | 经状态机 CAS；非法转移 → 409 INVALID_TRANSITION |

## 根目录 / 标签 / 工程 / 杂项
| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/roots`，POST `{path, mode}` | 库根 |
| DELETE | `/roots/:id` | |
| GET/POST | `/tags`，POST `{name, namespace?, color?}` | POST **幂等**（同名同 namespace 返回已存在的那条）。v3 起 GET 带 `color/sort/itemCount`，另有 `PATCH /tags/:id`、`DELETE /tags/:id`（见「分类体系 v3」） |
| GET/POST | `/projects`，POST `{name, path}` | Unity 工程 |
| POST | `/projects/:id/imports` `{itemId, assetId?}` | 记录"已导入"（**登记**，不代表工程里真的有） |
| POST | `/projects/:id/scan-usage` `{budgetMs?}` | 扫工程 Assets/ 的 GUID 与素材库求交，整表替换 `project_refs`（见「工程实际引用」） |
| GET | `/items/:id/usage` | 这个条目**被哪些工程真的用到** → `{itemId, projects:[{projectId,name,path,files,paths}]}` |
| GET | `/projects/:id/usage` | 这个工程**真的用到**了哪些素材 → `{projectId, name, items:[{itemId,title,files,paths}]}`（按 files 降序） |
| GET | `/media/:imageId?w=` | 缩略图/原图字节（sharp 生成缓存） |
| GET | `/stats` | `{items, assets, bytes, avatars, byCategory[], byAvatar[]}` |
| GET | `/export/items.json` | 全量导出 |
| GET | `/update-check?force=1` | 检查应用更新（见「检查更新」） |
| GET | `/unity/status` | Unity 桥探测（连不上也是 200） |
| GET | `/unity/packages?itemId=` | 可导入的 .unitypackage 清单 |
| POST | `/unity/import` `{itemId, keys?}` | **真导入**到当前打开的 Unity 工程 |

## 检查更新

`GET /update-check?force=1` —— 拿本机版本（deps.version）和 GitHub Releases 的最新 Release 比。**永远 200**：失败也是
`{ok:false, error, current, checkedAt}`，绝不 500（离线可用性是硬要求）。

成功 → `{ok:true, current:"0.1.0", latest:"0.2.0", hasUpdate:true, publishedAt:"...", url:"https://github.com/<owner>/<repo>/releases/tag/v0.2.0", notes:"release body 前 2000 字", assetName:"AssetVault-v0.2.0-win-x64-portable.zip", assetSize:12345678, checkedAt:"...", fromCache:false}`；
失败 → `{ok:false, error:"...", current, checkedAt}`。

- 数据源 `https://api.github.com/repos/<owner>/<repo>/releases/latest`；仓库默认 `elysia-5201/asset-vault`，
  settings 键 `update_repo`（形状 `owner/repo`，走 `PUT /settings {updateRepo}`）可覆盖；settings 键 `update_token` 存在时带 `Authorization: Bearer`（默认不需要 token）。
- 资产挑选：优先名字含 `portable` 的，其次第一个；挑不到则 `assetName/assetSize` 为 `null`。
- 版本比较见 `packages/core/src/version.ts`（`v` 前缀、`1.2`/`1.2.3`、预发布 < 正式）。
- 缓存：成功结果写 settings `update_last_check`（JSON），**6 小时内**不重复请求；`force=1` 绕过；`update_repo` 变化时缓存失效。失败不缓存。
- 请求超时 8s。

## Unity 编辑器（把素材**真的**导进当前打开的工程）

服务端自己当 MCP 客户端，连本机 `mcp-for-unity`（Streamable HTTP，默认 `http://127.0.0.1:8080/mcp`，其次 `14523`；可用 `PUT /settings {unityMcpUrl}` 覆盖），
用它的 `execute_code` 在编辑器主线程调 `AssetDatabase.ImportPackage(path, false)`——不是"登记一下"，是真的导入。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/unity/status` | 探测当前编辑器。**连不上也返回 200**：`{ok:false, error, candidates[]}`；成功时带 `editor:{projectPath, projectName, unityVersion, isPlaying, isCompiling, scenePath}` |
| GET | `/unity/packages?itemId=` | 这个条目里可导入的 `.unitypackage`（压缩包内的、含一层 zip 套 zip 的也列）：`{itemId, packages:[{key, label, assetId, container, sourcePath, entryPath, innerEntryPath, size, note?}]}` |
| POST | `/unity/import` `{itemId, keys?}` | `keys` 省略=全部（上限 20）。返回 `{ok, endpoint, project:{id,name,path,unityVersion}, imported[], queued[], failed[], consoleErrors[], consoleCleared}` |

行为要点：
- 导入前**清空 Unity 控制台**，导入后隔 1.8s 回读 `read_console` 的 error —— 所以 `consoleErrors` 一定是这次导入产生的。
- 压缩包内的包会先"落地"到 `<dataDir>/unity-staging/<assetId>/`，再交给 Unity（`AssetDatabase.ImportPackage` 只吃磁盘上的文件）。
- 当前工程会自动登记进 `projects`（`unity_version` 由编辑器上报）并写 `project_imports`。
- WSL 里跑服务也能用：路径会自动翻译成 `/mnt/c/...`→`C:\...`、其余→`\\wsl.localhost\<distro>\...`。

## 工程实际引用（素材是不是**真的**被工程用到）

`project_imports` 只是"我们登记过一笔"；`project_refs` 才是**证据**：拿两侧 GUID 求交。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/projects/:id/scan-usage` `{budgetMs?}` | 扫 `<project.path>/Assets` → 与素材库 GUID 求交 → **整表替换**该工程的 `project_refs`。返回 `{projectId, scannedFiles, guidCount, matchedGuids, matchedItems, matchedAssets, truncated, remaining, ms}`。工程不存在 → 404 |
| GET | `/items/:id/usage` | `{itemId, projects:[{projectId, name, path, files, paths}]}`；`paths` 最多 20 条（按路径排序），没扫过 → `projects: []`（不是 404） |
| GET | `/projects/:id/usage` | `{projectId, name, items:[{itemId, title, files, paths}]}`，按 `files` 降序 |

口径与取舍（冻结）：
- **工程侧**：递归扫 `Assets/`（跳过 Library/Temp/obj/Logs/.git/.svn/node_modules，深度 ≤12，文件数 ≤200k，单文件读取 ≤1MB），
  从每个 `*.meta` 的 `guid: <32 位 hex>` 取 GUID（`packages/core/src/unitymeta.ts`）→ 去掉 `.meta` 后缀即资源路径；命中的是**路径**不是"导入记录"。
- **素材侧**：`.unitypackage` 直读 `unitypackage_assets`；zip/7z/rar 走与"导入 Unity"同一条链
  （`listUnityPackageCandidates` → `stageUnityPackage` → `listUnityPackage`），单包 15s 超时、每资产最多 3 个内层包、内层包 >256MB 跳过。
- **缓存**：guid 索引按 `assetId:size:mtime` 内存缓存（上限 64 条），**空结果不缓存**（偶发读失败不该被钉死）。
- **预算**：默认 45s（`budgetMs` 可覆盖，最小 1s）。超预算提前返回且 `remaining:true`；先查"DB 里已有 GUID 清单"的资产（不解析），
  再按体积从小到大解析压缩包 —— 预算内尽量多覆盖，大包下次接着扫。
- **替换语义**：每次扫描**先删该工程旧行再插**。`truncated`/`remaining` 为 true 说明这次没看全，重扫一次会补齐（有缓存，第二次更快）。

## 响应包裹形状（实测固定，前端请按此解析）

| 端点 | 形状 |
|---|---|
| `GET /items`, `GET /items/:id` | 对象（`{total, items}` / ItemDetail） |
| `PATCH /items/:id`, `POST /items/:id/tags`, `DELETE /items/:id/tags/:tagId`, `POST /items/:id/images/reorder` | ItemDetail |
| `POST /items/:id/avatars`, `DELETE .../avatars/:avatarId` | ItemDetail 的 avatars 部分为 `[{avatarId, name, match, confidence, evidence, source}]` |
| `GET /assets/:id/tree` | `{container, path, entries}` |
| `GET /assets/:id/unitypackage` | `{assets, total, byType}` |
| `GET /avatars` | `{avatars: AvatarCard[]}`（含 `itemCount`/`owned`/`aliases`） |
| `GET /jobs` | `{jobs: JobRow[]}` |
| `GET /jobs/:id/events` | `{events: JobEventRow[]}` |
| `POST /jobs/:id/{pause,resume,cancel,retry,abandon}` | **裸 JobRow**（非法转移 → 409 `{error:{code:"INVALID_TRANSITION"}}`） |
| `GET /roots` | `{roots, stats}` |
| `GET /tags` | `{tags}` |
| `GET /stats` | 统计对象 |
| `POST /scan` | `{jobId, state}`；`{dryRun:true}` 时返回 `{dryRun, path, files, dirs, bytes, truncated, items[]}` |
| `POST /categories` | `{category: CategoryNode}`（201） |
| `PATCH /categories/:id`, `PUT /categories/config` | `{category}` / `{autoThreshold, suggestThreshold}` |
| `POST /items/:id/category`, `.../category/accept`, `.../category/dismiss` | `{item: ItemDetail}` |
| `POST /items/category/batch` | `{updated, failed: [{itemId, reason}], requested}` |
| `POST /categories/reclassify` | `{scanned, applied, suggested, cleared, skipped, protected, results[]}` |

## 媒体
`GET /media/:imageId` 直接返回缩略图（webp，最长边 512）；原图缺失时才回退原文件。可直接作 `<img src>`。

## 物品分类（v2）

用户自己的分类体系（可手改、可自动推荐），与 BOOTH 商品页自带的只读分类（`items.category_name/category_parent`）**是两回事**。
数据在 `items.cat_id / cat_sub_id` + 13 个 `cat_*` 列，结构固定**两层**（主分类 `parent_id IS NULL`，子分类 ID 形如 `clothing.tops`）。
`cat_id IS NULL` = **未分类**（UI 灰 chip）；分类树里 `other.uncategorized`（「其他 › 未分类」）是用户**显式选择**的一个分类，二者不同。
归属来源 `cat_source`：`manual`（下拉框手选）/ `confirmed`（采纳建议）/ `auto`（自动推断）/ `migrated`（历史迁移）。
**`manual`/`confirmed` 永不被自动任务覆盖**：自动路径只走 `repo.applyAutoCategory()`（受保护时只写待确认建议，返回 `protected:true`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/categories` | `{categories: CategoryNode[]（树，含 itemCount）, stats: CategoryStats, config: {autoThreshold, suggestThreshold}}`。初始库 = 14 主分类 / 79 子分类 = 93 个节点（`packages/core/src/categories/taxonomy.ts`），首次建库/迁移时播种 |
| POST | `/categories` `{id?, name, parentId?, sort?}` | 建分类 → **201** `{category}`；`id` 已存在 → 409；`parentId` 不存在 → 400 |
| PATCH | `/categories/:id` `{name?, sort?, enabled?, parentId?}` | → 200 `{category}`；不存在 → 404；移动受两层结构约束（子分类不能再改父、有子分类的主分类不能移动）→ 400/409 |
| DELETE | `/categories/:id` | → 200 `{moved, movedSubs}`。其下素材退回未分类（**不删素材**）；还有子分类 → 409 |
| PUT | `/categories/config` `{autoThreshold?, suggestThreshold?}` | 阈值（0..1，可给数字或数字串），写 settings `category_auto_threshold` / `category_suggest_threshold` → `{autoThreshold, suggestThreshold}`；非法值 → 400；读侧坏值回落默认 `{0.75, 0.4}` |
| POST | `/items/:id/category` `{categoryId: string\|null, subCategoryId?: string\|null}` | 手动设分类（`source='manual'`）→ `{item}`。`categoryId=null` 清除归属；传子分类 ID 会自动归位到其主分类；未知分类 ID → 400；子分类不属于主分类 → **自动清空子分类**（不 400） |
| POST | `/items/:id/category/accept` | 采纳当前建议：`source='confirmed'` + 清建议 → `{item}`；没有建议 → 400 |
| POST | `/items/:id/category/dismiss` | 忽略建议：只清建议，**不动归属** → `{item}` |
| POST | `/items/category/batch` `{itemIds: number[], categoryId?, subCategoryId?, mode?}` | 批量 → `{updated, failed: [{itemId, reason}], requested}`。`mode`：`set`（默认，设为某分类/清空）/ `clear_sub`（保留主分类、只移除子分类）/ `resuggest`（重算建议）。`itemIds` 空 → 400；不存在/无子分类可移的条目进 `failed`，不中断 |
| POST | `/categories/reclassify` `{itemIds?, onlyUncategorized?, apply?, all?, limit?}` | 批量重跑 → `{scanned, applied, suggested, cleared, skipped, protected, results: [{itemId, categoryId, subCategoryId, confidence, level, applied, protected, reason}]}` |

**`/items` 分类筛选**（可与关键词/Avatar/标签/收藏/拥有状态组合，全部落到真实 SQL）：
`catIds=clothing,clothing.tops`（逗号分隔或 `&catIds=a&catIds=b` 重复键均可；选中主分类命中其自身、选中子分类命中子分类），
`catMatch=any`（默认）/ `all`（条目路径必须同时命中每个选中节点），`uncategorized=1`（`cat_id IS NULL`），`pendingCategory=1`（有未确认建议）。

**分级与阈值**（`packages/core/src/categories/classify.ts`）：置信度 = `min(1, score/2)`，与第二名差距 < 35% 时 ×0.6（歧义降权）；
`>= autoThreshold` → `level="auto"`（允许自动应用，必须可追溯：`cat_reason` + `cat_evidence` JSON）；`>= suggestThreshold` → `"suggest"`（只给建议）；
否则 `"none"`（保持未分类，**不为凑自动分类率硬塞**）。**置信度未校准，不得当真实概率**。

**自动分类钩子**（全部 try/catch 包住，分类异常绝不阻断主流程；入口见 `apps/server/src/services/categories.ts`）：
① 扫库建档 / `POST /import/paths`（`jobs/runner.ts` 在 indexing+matching 完成后，含 Inbox 入库）；
② BOOTH 链接导入 / 补全元数据（`services/booth.ts`，覆盖 `POST /items/:id/link-booth`）；
③ 后台任务（`jobs/runner.ts`，reindex / match_avatars / import_url / check_update 同样覆盖）；
④ `PATCH /items/:id` 且 body 含 `title/title_ja/description/category_name/category_parent/shop_name/author` 时（纯 UI 开关如 favorite/status 不触发）。

**`reclassify` 语义**（范围优先级为实现口径，已与 lead 报备）：范围 = `itemIds` > `onlyUncategorized:true` > `all:true`，三者都不给 → 400（不静默全库改分类）；
`limit` 默认 500、上限 5000。`apply` 默认 **false**（只写建议、不改归属）；`apply:true` 时 level=auto 才写归属，且只经 `applyAutoCategory`，
用户已定的记 `protected:true`（不一致时只写建议）。计数器互斥：`applied + suggested + cleared + skipped === scanned`。
`cleared` = 清掉的过期建议（无证据、或推荐与当前归属一致）；`skipped` = 无需变动（含推荐与当前归属一致且没有旧建议）。
推荐与当前归属一致时**不会**再挂一条待确认建议。

## 分类体系 v3（标签 / 筛选计数 / 分类管理）—— 契约 docs/categories-v3.md

v3 是 v2 之上的**增量**：一级分类 15 个（含系统分类「未分类」，0 子分类）+ 80 个二级子分类 = 95 个节点。
- `uncategorized`（未分类）是**系统一级分类**：不可删除、不可停用，永远可访问，也是删除/合并的合法转移目标。
  v2 一节里 `other.uncategorized` 的说法在 v3 已不存在（v3 的 other 只有 `other.unclassed` / `other.pending`）。
- **未分类的规范存储仍是 `items.cat_id IS NULL`**：`cat_id IS NULL` 与 `cat_id='uncategorized'` 视为同一集合
  （筛选与计数都用这个口径），所以不用给历史素材回写一行 —— 与旧的 `uncategorized=1` 完全等价。
- 分类结构固定两层；**ID 不随位置变化**：子分类可以被移动到另一个一级分类下（ID 不变，前缀可能与实际父不一致）。

⚠️ 静态段（`/categories/counts`）注册在 `/categories/:id*` 之前 —— `apps/server/src/http/routes.ts` 里静态段一律先注册。

### 标签（与分类严格分开；身份 = `(namespace, name)`，**颜色不是身份**）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/tags` | `{tags: [{id, name, namespace, color, sort, itemCount}]}`，按 namespace → sort → name 排序 |
| POST | `/tags` `{name, color?, namespace?}` | 新建 → **201** `{tag}`；**同名（同 namespace）幂等**：直接返回已存在的那条 → 200 `{tag}`，绝不重复创建。`name` 空 → 400 |
| PATCH | `/tags/:id` `{name?, color?, sort?}` | → `{tag}`。改名按 **id** 关联，素材上的标签自动跟随；改成已存在的名字 → 409；不存在 → 404 |
| DELETE | `/tags/:id` | → `{removed: n}`（同时删 `item_tags` 关联；**不删素材、不删文件**）；不存在 → 404 |

默认标签**只播种一次**（`settings.tags_seed_version`；`apps/server/src/server.ts` 启动时调
`repo.seedDefaultTags(DEFAULT_TAGS, TAGS_SEED_VERSION)`，表在 `packages/core/src/categories/default-tags.ts`）：
哥特风 / 可爱风 / 赛博风 / 黑色 / 白色 / 免费 / 已购买 / PhysBones / Modular Avatar / Quest 兼容 / 待检查。
用户删掉的**不会**被下一次启动复活。

### 筛选参数（`/items` 与 `/categories/counts` 完全共用同一解析器，v3 增量）

| 参数 | 说明 |
|---|---|
| `tags=a,b` | 标签多选（逗号分隔或重复键），形状与 `avatar` 一致；与旧的单个 `tag=` **同时给出时是 AND** |
| `tagsMatch=any\|all` | 默认 `any`（命中任一标签）；`all` = 必须同时具备全部标签（`COUNT(DISTINCT t.name) = N`） |
| `favoriteOnly=1` | 只看收藏（`items.favorite = 1`） |

关键词 / 分类（`catIds` + `catMatch`）/ 标签（`tags` + `tagsMatch`，或旧 `tag`）/ 头像 / 来源 / 状态 / 容器 / 已导入 /
收藏 / 未分类 / 待确认建议 全部在 `repo.buildWhere()` 里拼成**一条真实 SQL**（路由层不做二次过滤，前端也不过滤）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/categories/counts?...与 /items 相同...` | 当前筛选下的分类计数：`{all, uncategorized, tops: {id: count}, subs: {id: count}}`。**一次 GROUP BY** 算出（不是每个分类查一次）；**分类筛选参数本身不参与计数**（repo 层已剔除，否则只会剩被选中的那个分类）。恒等式：`counts.all === GET /items（同一 query）.total`，`counts.uncategorized === GET /items?uncategorized=1.total` |

### 分类管理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/categories/:id/impact` | 删除/合并前的影响面 → `{items, direct, subs, suggestions, children: [{id, name}]}`；不存在 → 404 |
| POST | `/categories/:id/move` `{parentId}` | 子分类换父（**ID 不变**，允许跨一级分类）→ `{category}`；一级骨架不可移动 / 目标不是一级 / `parentId` 缺失 → 400；不存在 → 404 |
| POST | `/categories/:id/merge` `{intoId}` | 合并 → `{moved, deleted, movedSuggestions}`：素材与待确认建议先迁到 `intoId`，再删源（**事务**，绝不删素材）。**系统分类不能作为合并源 → 409**；只允许同级合并（一级↔一级、子↔子）→ 400；`intoId` 缺失 → 400 |
| DELETE | `/categories/:id?transferTo=<id\|none>` | → `{moved, movedSubs, deleted, movedSuggestions}`：素材先转移再删行（**事务**）。`transferTo` 缺省或 `none` = 未分类（清空归属）；系统分类 → 409；不存在 → 404 |

**系统分类（`builtin=true`）不可删除、不可停用**：`DELETE /categories/:id` 与 `PATCH /categories/:id {enabled:false}` 都 → 409
（改名/排序不受限）；普通分类可自由增删改移合并。

**合并一级分类的子分类语义（实现口径）**：`repo.mergeCategories` 合并一级分类时会把它**原有的子分类一并删除**，
指向这些子分类的素材只清空 `cat_sub_id`（主分类改指目标）。因此返回的 `deleted` = 1(源) + N(被删的孤儿子分类)，
调用方请按 `deleted >= 1` 判断「源分类已消失」，不要写死 `=== 1`。

### 建议标签（只建议，**绝不**自动写 `item_tags`）

`GET /items/:id` 的响应额外带 **`suggestedTags: [{name, reason}]`**（v3 增量、只读派生，见
`apps/server/src/services/categories.ts` 的 `suggestTagsFor`）：按已有证据（标题/日文标题/描述/备注/文件名/包内路径）
匹配少量高置信关键词（PhysBones / Modular Avatar / Quest 兼容 / 免费 / 哥特风 / 可爱风）；
只建议**标签表里已存在**且该条目**还没有**的标签（用户删掉的标签不会被复活），**绝不写库**；任何异常一律返回 `[]`。

### 计数口径小结

- `GET /categories` 的 `stats.counts[].count` = **全局计数**（不受筛选影响）→ 管理页用。
- `GET /categories/counts` = **当前筛选下**的计数 → 分类导航栏用（UI 需标明「当前筛选下」）。
- 两者都只统计 `status <> 'trashed'`；未分类 = `cat_id IS NULL OR cat_id = 'uncategorized'`。



## 扫描变更中心（v4）

持久化预览 + 确认应用。设计、状态与安全规则见 `docs/scan-preview.md`；这里只列表。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/scan/previews` `{rootId?|path, deep?}` | 建预览；**同 path+deep 已有活跃预览时返回 200 `{existing:true, previewId}`**，否则 202 `{previewId, state, jobId}`。预览生成是一个 `scan` 作业（payload.mode=preview） |
| GET | `/scan/previews?limit=` | 预览列表（自动把超过 TTL 的 ready/partial 标 `expired`） |
| GET | `/scan/previews/:id` | `{preview:{…, counts, itemCounts, scan, plan_hash}, applies:[…], errors:[…]}` |
| GET | `/scan/previews/:id/items?cursor=&limit=&change=` | keyset 分页；`change` 可筛 new/changed/missing/duplicate_suspected/unchanged/unreadable/error |
| POST | `/scan/previews/:id/items` `{keys[]|change, decision}` | 勾选（accept/skip/pending）；按 change 批量 |
| POST | `/scan/previews/:id/apply` `{planHash?, mode:"all"?, itemKeys[]?, idempotencyKey?}` | 202 `{previewId, applyRunId, jobId, files, missing, stale, requested}`；`planHash` 不一致 409 `STALE_PREVIEW`；过期 410；applying 409；同 `idempotencyKey` 返回原批次 |
| POST | `/scan/previews/:id/cancel` | → cancelled（applying 时 409） |
| POST | `/scan/previews/:id/retry` | 只重试「applied=0 且有 error」的条目 → 202 |
| DELETE | `/scan/previews/:id` | `{deleted}`；applying 时 409 |

**apply 的实际动作**：只做 登记新文件 / 重新索引变化文件 / 把用户确认的缺失资产标 `missing`；
复用 scan 作业的显式文件列表管线（建条目→登记→索引→匹配→分类）。**不移动、不删除源文件，不自动合并重复项**；
应用前逐条重新 `stat`，与预览快照不一致即 `stale`（写进条目 error，不写库）。
`marked missing` 由用户勾选触发，不再经过整轮扫描门控；整轮扫描本身仍遵守 M0 的"不完整不判缺"。
