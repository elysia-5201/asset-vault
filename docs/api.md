# AssetVault HTTP API（FROZEN v1）

Base: `http://127.0.0.1:7317/api`。所有响应 JSON；错误：`{ "error": { "code": AppErrorCode, "message": string } }` + 对应 HTTP 状态
（400 INVALID_INPUT / 404 NOT_FOUND / 409 INVALID_TRANSITION|CONFLICT / 502 UPSTREAM_ERROR / 401 LOGIN_REQUIRED）。

## 条目
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, version, dbPath, roots, counts}` |
| GET | `/items?q=&sort=relevance&limit=&offset=` | `{total, items, search?}`。统一搜索支持中日英关键词、商品号、路径及高级条件。已有 Avatar、分类、标签和状态参数继续生效。 |
| GET | `/search/suggestions?q=` | 返回搜索建议。 |
| GET | `/search/facets?dimension=avatar` | 返回指定筛选维度的值与计数。 |
| GET | `/search/alternatives?q=` | 返回单独放宽条件后的数量与索引状态。 |
| GET / POST | `/search/index` | 查看索引进度，或提交修复、重建、暂停等维护操作。 |
| GET / PUT / DELETE | `/search/lexicon` | 查看自定义词库。写入和删除使用 `/search/lexicon/:id`。 |
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
| POST | `/items/:id/assets/scan` | 核对本条登记的路径，更新已确认的存在状态。返回 `{files:[{assetId,path,state,changed,reason?}]}`，状态为 `present`、`missing` 或 `unavailable`。 |
| GET | `/assets/:id/relocation-candidates` | 对已标记缺失的文件按 SHA-256 和大小查找已登记的副本，返回 `{candidates:[{assetId,itemId,title,path}],reason?}`。 |
| POST | `/assets/:id/relocate` | 提交 `{expectedPath,expectedItemId,candidateId,expectedCandidatePath,expectedCandidateItemId}`。复核旧路径和候选文件内容，保留原文件编号，将所选副本的路径归到原卡片。 |
| POST | `/assets/:id/remove-missing` | 提交 `{expectedPath,expectedItemId}`。复核旧路径后移除文件登记，保留磁盘文件和导入历史。两项操作成功均返回 `{ok:true}`。 |
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
| POST | `/import/download` `{url \| protocolUrl, fileName?, itemId?, downloadRoot?}` | BOOTH 协议接管 / 手动粘贴：有界流式落盘 → `{itemId, path, bytes, fileName, images, assetId, jobId}`（边界见下） |

**下载边界（task-3，BOOTH 文件）**

- **流式落盘**：逐块写入目标目录内的唯一临时文件 `.av-dl-*.tmp`，完成后才发布；这条路径不再出现 `arrayBuffer()` / 整包 `Buffer` / `.text()`。HTML 登录页只用 **256 字节有界前缀**判定（→ 401 `LOGIN_REQUIRED`），不会为了判类型读完整包。
- **实际字节硬上限**：默认 **8 GiB**（`DEFAULT_DOWNLOAD_MAX_BYTES`），累计的是**实际读到的 body 字节**；`Content-Length` 仅用于提前拒绝，缺失或伪造都不能绕过 → 413 `TOO_LARGE` 并清理。
- **全流程 deadline**：默认 **30 分钟**（`DEFAULT_DOWNLOAD_DEADLINE_MS`）。从首个请求开始计时，**跨所有重定向、body 读写、收尾（flush/close）与发布前后共享、逐跳不重置**；stall 的响应体、永不返回的写回调/收尾都会被 abort 打断 → 504 `UPSTREAM_TIMEOUT`。**限制**：`link`/`stat` 这类同步系统调用无法被定时器抢占，因此发布前后各按绝对时间复查一次——越过 deadline 就撤销刚独占发布的成品（只删自己创建的名字）并报超时，绝不返回"晚到的成功"。**清理等待共享一份有限预算**（`CLEANUP_WAIT_MS` = 2s）：`finished`（flush/close）与 `reader.cancel()` / `body.cancel()`（含重定向、HTTP 失败、`Content-Length` 预拒等早期分支，走同一个公共 helper）共用这份时间，不会各自累加；句柄永不 close 或取消失败/永不 settle 时仍会有限收尾、并且继续 `unlink` 临时文件（清理定时器不做 `unref`，保证没有其它 handle 时 Promise 仍会结算）。错误文本不含下载 URL/凭据/签名参数。
- **没有 fsync，不提供掉电持久化保证**：收尾只做 flush + close，进程崩溃/断电可能丢失已写数据；本轮不通过新增 `fsync` 扩大范围。
- **两个边界互相独立**：字节上限管"多大"，deadline 管"挂多久"；30 分钟只兜住病态挂起，**不是任何真实带宽/大文件场景的吞吐保证，未在真实 BOOTH/大文件上实测**；测试一律注入短 deadline，不等 30 分钟。
- **重定向**：每一跳都重新校验 `https://*.booth.pm` 白名单，跳数上限 6；被拒绝的目标主机不会被请求。
- **发布**：只用 `link()` 语义**独占**发布，绝不覆盖既有同名文件——既有的同名文件保持原样，新内容自动改用 `name (1).ext` 这类候选名；即使竞争者在"检查通过之后"抢先建成同名文件，也只会让出名字（`EEXIST` → 换下一个候选），不存在 check-then-rename 覆盖窗口。**硬链接不可用（`EPERM`/`ENOTSUP`/`EXDEV`/`ENOSYS`/`EACCES`/`EMLINK`）时 fail-closed**：直接报 502 并删除临时文件，**不复制、不 rename、不产生任何终名**；不再有 `COPYFILE_EXCL` 回退（同步整包复制会阻塞事件循环、令 deadline 失效，且复制中途失败可在终名下留下部分成品）。
- **失败清理**：超限 / 断流 / 超时 / HTTP 失败 / HTML 登录页 / 写盘失败都会关闭文件句柄、取消响应 body（含重定向与 HTTP 失败等早期分支，走同一个公共 `cancelBody` helper）、删除临时文件；既有目标文件保持不变；所有清理等待共享同一份有限预算（`CLEANUP_WAIT_MS`），不会因为句柄永不 close 或 `cancel()` 永不 settle 而永挂（取消失败也照常 `unlink` 临时文件）。
- **可覆盖项**：`downloadBoothFile` 接受 `maxBytes` / `timeoutMs`（`maxHops`）覆盖，但必须是**正有限整数**，否则 `INVALID_INPUT` 且不发起任何请求；HTTP 路由当前不暴露这些覆盖，运维默认值即上面两项。
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
| POST | `/unity/import` | **已弃用（409）**：直导绕过计划/风险确认/作业验证，改用 `/import-plans` |

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
| GET | `/unity/status` | 探测当前编辑器。**连不上也返回 200**：`{ok:false, error, candidates[], dropped, allowRemote}`；成功时带 `editor:{projectPath, projectName, unityVersion, isPlaying, isCompiling, scenePath}`。`candidates` 是**边界过滤且已脱敏**的地址（非回环/非法地址被丢弃，只在 `dropped` 里计数，不回显主机/凭据）；`error` 文本里的 URL 也过脱敏（连接串里的 `?token=` 与旧库 userinfo 一律剥离） |
| GET | `/unity/packages?itemId=` | 这个条目里可导入的 `.unitypackage`（压缩包内的、含一层 zip 套 zip 的也列）：`{itemId, packages:[{key, label, assetId, container, sourcePath, entryPath, innerEntryPath, size, note?}]}` |
| POST | `/unity/import` | **已弃用**：永远 `409 {error:{code:"UNITY_IMPORT_REQUIRES_PLAN", message, migration:{plan,confirm,execute,workbench}}}`，**无任何副作用**（不连 Unity、不落 staging、不写 `project_imports`）。导入请走 `/import-plans`（见「头像工作台」） |

行为要点：
- **MCP 端点边界**（task-1）：`settings.unity_mcp_url` 写库前校验形状/协议（只 http/https、不得内嵌用户名密码），非回环主机默认拒绝（`REMOTE_NOT_ALLOWED`），需显式 `PUT /settings {unityMcpAllowRemote:true}`（底层键 `unity_mcp_allow_remote=1`，设置面板「允许非回环 Unity MCP 端点」，默认关闭并提示风险）才放行；**旧库脏值同样校验**（`file://`、无效串、内嵌凭据即便 allowRemote=1 也被丢弃），日志/健康/状态只出现脱敏地址。
- **`PUT /settings` 原子性**：先校验全部入参（`downloadRoot`/`unityMcpUrl`/`unityMcpAllowRemote`/`updateRepo`），任一非法直接 400 且**不写任何一项**（含不创建下载目录、不改 `unity_mcp_url`）；关掉 `unityMcpAllowRemote` 会同时清掉已存的远程地址。
- **详情页 → 工作台上下文**：详情页勾选的包按 `assetId + rel_path`（直接 unitypackage=文件名、压缩包内=entryPath、zip 套 zip=`entryPath::innerEntryPath`）映射到工作台单元，只有精确且无歧义（同资产单单元、无互斥槽位冲突）的才预选；对不上/多义时不预选并显式提示，仍需人工「生成计划 → 看风险 → 确认 → 执行」。详情页不再有直接导入入口。
- 导入前**清空 Unity 控制台**，导入后回读 `read_console` 的 error —— 计划执行链路按单元做，逐项状态可追溯（`import_runs` / `run_items`）。
- 压缩包内的包会先"落地"到 `<dataDir>/unity-staging/<assetId>/`，再交给 Unity（`AssetDatabase.ImportPackage` 只吃磁盘上的文件）。
- 当前工程会自动登记进 `projects`（`unity_version` 由编辑器上报）并写 `project_imports`。
- WSL 里跑服务也能用：路径会自动翻译成 `/mnt/c/...`→`C:\...`、其余→`\\wsl.localhost\<distro>\...`。

### Unity MCP 一键安装（additive）

只改目标工程 `Packages/manifest.json` 的目标依赖；预览只读，应用才写；`packages-lock.json` 只备份作证据，不编辑、不恢复。`config_applied` 只表示配置已写入，不等于 UPM 已解析、已编译、bridge 已连接或工具兼容。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/unity/install/preview` `{projectPath}` | 只读预览：返回 `previewId/expiresAt/project/package/diff/backup/prerequisites/warnings/previewHash`；`package.change` 为 `add/replace/none/conflict`；TTL 10 分钟 |
| POST | `/unity/install/apply` `{previewId, confirm:true, confirmReplace?}` | 只接受服务端预览；body 不接受客户端 `projectPath/package`；返回 `{operationId,status,manifestHash,backupDir,warnings}`；同版本 `already_installed` 不写文件 |
| GET | `/unity/install/status?projectPath=` | 只读 manifest / `packages-lock.json` / 上次 probe 结果；**零 Unity 调用**；`compile/bridge/tool/server` 取不到时为 `unknown` |
| POST | `/unity/install/probe` `{previewId?\|operationId?}` | 显式只读探测；工程来自服务端 preview/op；先取 Editor 工程路径再匹配；错工程不查编译；不 ImportPackage |
| GET | `/unity/install/operations/:id` | 读取操作记录（`config_applied/rolled_back/interrupted/conflict` 等） |
| POST | `/unity/install/operations/:id/rollback` `{confirm:true}` | 仅当前 manifest hash == 本次 `afterHash` 时恢复原字节；不恢复 lock；外改返回 409 并给当前 diff |
| POST | `/unity/install/previews/:previewId/cancel` | 失效未应用的预览；不写工程、不回滚 |

错误：外层复用 `INVALID_INPUT`/`NOT_FOUND`/`CONFLICT`/`UPSTREAM_ERROR`；422 固定 `INVALID_INPUT`；具体子码在 `error.details.code = UNITY_INSTALL_*`（如 `UNITY_INSTALL_PROJECT_INVALID`、`UNITY_INSTALL_PREVIEW_STALE`、`UNITY_INSTALL_REPLACE_NOT_CONFIRMED`、`UNITY_INSTALL_ROLLBACK_CONFLICT`、`UNITY_INSTALL_LOOPBACK_ONLY`）。不新增外层 enum。

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

## 深度索引流水线（v5）

扫描 / 应用 / 导入作业在 `indexing` 阶段把资产交给后台流水线，然后照常走
`index_ok → matching → releasing_done → done`。流水线是 `jobs` 的派生子任务队列
（`index_tasks`），不是第二套作业状态机。完整设计见 `docs/pipeline-v06.md`。

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/pipeline` | 总览：计数、每阶段（queued/running/waitingRetry/failed/done/skipped/avgMs）、缓存、内存、最近失败、limits 与 nonDefaultLimits |
| GET | `/pipeline/tasks?state=&stage=&assetId=&limit=` | 任务列表；每条额外带资产 `path`/`size` |
| GET | `/pipeline/tasks/:id` | `{task, asset}`；404 `NOT_FOUND` |
| GET | `/pipeline/events?after=&limit=` | 诊断事件（`stale / limited / retry / failed / cancelled / recovered`），`after` 为事件 id 游标 |
| POST | `/pipeline/tasks/:id/retry` | 人工重排：`attempts=0`、清错误与退避 |
| POST | `/pipeline/tasks/:id/cancel` | 排队任务直接取消；运行中触发协作取消（`AbortSignal`） |
| POST | `/pipeline/assets/:id/reindex` `{priority?}` | 入队整条阶段链；有流水线时返回 `{queued, tasks[]}`，否则同步索引返回 `{result}` |
| POST | `/pipeline/assets/:id/boost` `{priority?}` | 提升排队任务优先级（交互式打开详情页时用） |
| POST | `/pipeline/pause` / `/pipeline/resume` | 暂停/继续领取（`{paused, enabled}`） |
| POST | `/pipeline/gc` | 手动缓存回收 `{removed, bytes, expired}` |
| GET | `/pipeline/limits` | 当前生效限制 + 非默认项 |
| PUT | `/pipeline/limits` | 保存到 `settings.pipeline_limits`；返回 `{saved, restartRequired:true, limits}` |

### 任务状态

`queued → running → done | skipped | waiting_retry | failed | cancelled`

- `skipped` 不是失败：`error_code` ∈ `NOT_APPLICABLE / BYTES / ENTRIES / PIXELS / RATIO / UPSTREAM_FAILED / STALE / ASSET_GONE`。
- `waiting_retry` 的 `next_retry_at` 到期后由 worker 每秒提升回 `queued`（无需重启）。
- `attempts` 在领取时 +1；退避 `min(retryMaxMs, retryBaseMs * 2^(attempts-1))`；超过 `max_attempts` → `failed`。
- 进程崩溃后启动时 `running → queued`（不增 attempts），并写 `pipeline_events(event='recovered')`。

### 数据表

- `index_tasks`：唯一活跃索引 `(asset_id, stage)`（queued/running/waiting_retry），`depends_on` 显式依赖。
- `pipeline_events`：只增诊断事件（崩溃恢复/取消/超限/重试/失败）。
- `cache_entries`：缓存元数据；文件在 `<dataDir>/cache/<kind>/<key>.json`（tmp + rename 原子写）。
- `assets`：`index_state`（pending/queued/running/done/failed/limited）、`index_error`、`indexed_at`、`content_version`。

### 迁移

`SCHEMA_VERSION 4 → 5`，幂等；只新增表/列，不改既有语义。
v0.5.1 可打开 v5 库（多出的表/列被忽略），但不会消费 `index_tasks`；回滚前请备份
`vault.db` + `vault.db-wal` + `vault.db-shm`（只复制主库会因 WAL 重放不一致）。

## 导入预检 / 两阶段下载 / 版本关系（feature123，v10）

本节只追加新端点；既有条目与响应形状不变。所有错误沿用 `{error:{code,message,details?}}`，
子码只放 `details.code`（不新增外层 `AppErrorCode`）。

### 导入预检（只读）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/import/precheck` `{paths[], source?, budget?}` | 只读预检：不写库、不建 job、不写缓存。返回 `{checkedAt, budget:{maxBytes,maxMs,usedBytes,usedMs,truncated}, results[]}`；每行含 `path/pathNorm/group/size/mtime/hash/match/summary/warnings`。`paths` 必须是绝对路径；目录会展开（深度/数量/字节/时间预算内），超预算 `truncated=true` 且未展示的文件不会被登记。 |

### 接受列表导入

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/import/paths` `{files:[{path,expected:{size,mtime,sha256?},group?}]}` | 新形状：每个文件一个 `import_file` job（payload `{path,expected,group}`），**不递归**；目录 → 400 `DIRECTORY_NOT_ALLOWED_WITH_FILES`；缺 expected → 400 `EXPECTED_REQUIRED`；重复路径按 `path_norm` 去重进 `duplicates`。返回 `{jobIds,duplicates,legacy:false}`。 |
| POST | `/import/paths` `{paths:[...]}` | 旧形状原样保留：目录递归、无 expected，payload 记 `legacy:true`。返回 `{jobIds,duplicates:[],legacy:true}`。 |

执行期重验：`expected.sha256` 存在则当次强制重算并比对（`verified:"sha256"`），否则只比 size+mtime
（`verified:"metadata"`，不冒充 exact）。任何不一致 → `PRECHECK_STALE`，不登记。

### 两阶段下载（stage → commit）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/import/download` `{stage:true,url,itemId?,fileName?,downloadRoot?}` | 只下载 + 只读预检 + 发 token：**不建 item/images/tags/job**。下载根来自服务端配置（`download_root` 或 `<dataDir>/downloads`）；body `downloadRoot` 只能与之一致，不一致 400。返回 `{staged:true,stageToken,bytes,fileName,precheck,meta?}`。 |
| POST | `/import/download/commit` `{stageToken,decision:"import"\|"skip"}` | token 校验/重算在事务外；回执优先（重放返回原指针）。`import` → 建/复用条目 + 登记资产；`skip` → 只消费 token，文件保留。子码：`STAGE_TOKEN_INVALID`(410) / `STAGE_TOKEN_EXPIRED`(410) / `STAGE_TOKEN_CONSUMED`(409) / `STAGE_FILE_CHANGED`(409) / `STAGE_COMMITTED_OBJECT_DELETED`(410)。 |
| POST | `/import/download`（无 `stage`） | 旧一步式下载：行为与响应形状不变（`{itemId,path,bytes,fileName,images,assetId,jobId}`）。 |

### 同步登记资产（expected 强验 + 严格 owner 门）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/items/:id/assets` `{path,expected?}` | 任何业务写入前：有 `expected` 先重验 size/mtime（有 sha256 强制重算）→ 不一致 409 `PRECHECK_STALE`；随后查 `path_norm` 归属 → 属于另一个条目 409 `PATH_OWNED_BY_OTHER_ITEM`（`details:{itemId,assetId}`），不登记、不迁 owner；同 owner 幂等（`added:0`）。无 `expected` 的 legacy 请求跳过重验，但 owner 门仍生效。返回 `{added,assetIds}`。 |

### 版本关系

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/items/:id/version-links?state=&limit=&offset=` | `{itemId,total,links[]}`；每条含 `assets:{a,b}` 只读投影。 |
| POST | `/items/:id/version-links` `{assetAId,assetBId,relation,basis?,evidence?}` | 人工建立的是 `candidate`（需确认），不冒充 proven；两个资产必须都属于该条目。 |
| PATCH | `/items/:id/version-links/:linkId` `{state?,relation?,expectedVersion}` | CAS：`expectedVersion` 过期 409。 |
| DELETE | `/items/:id/version-links/:linkId` | 删除关系记录（不动资产）。 |

### 按模型搭配清单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/avatars/:id/loadouts` | `{loadouts[]}`（含 `itemCount/stateCounts/trashedCount/version`）。 |
| POST | `/avatars/:id/loadouts` `{name,note?}` | 201 `{loadout}`；同名 409 `LOADOUT_NAME_TAKEN`。 |
| GET | `/loadouts/:id?state=&includeTrashedItems=0\|1&limit=&offset=` | 详情：`{loadout,total,stateCounts,visibleStateCounts,trashedCount,items[]}`；墓碑行永不返回。 |
| PATCH | `/loadouts/:id` `{name?,note?,sort?,expectedVersion}` | 只保护 name/note/sort；CAS 失败 409 `LOADOUT_VERSION_CONFLICT`。 |
| DELETE | `/loadouts/:id` | 只删清单与清单项，不删 item/asset/文件。 |
| POST | `/loadouts/:id/items` `{itemIds[],state?,note?}` | 幂等添加：已有活跃行不覆盖；墓碑行复活到末尾。 |
| POST | `/loadouts/:id/items/reorder` `{itemIds[],hiddenIds?}` | 只提交可见行；截断时 400。 |
| PATCH | `/loadouts/:id/items/:itemId` `{state?,note?,position?,expectedVersion}` | 条目级 CAS 409 `LOADOUT_ITEM_VERSION_CONFLICT`。 |
| DELETE | `/loadouts/:id/items/:itemId` | 墓碑删除（`removed:0\|1`，幂等）。 |

### 整理待办

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/cleanup/todos?localSourcePolicy=&rule=&ignored=&q=&avatar=&category=&sort=&limit=&offset=` | 纯读派生；`localSourcePolicy` **必填**（缺失 400 `LOCAL_POLICY_REQUIRED`）。`total` 是当前列表行数，`counts` 是规则命中计数（不受 rule/ignored 过滤）。 |
| GET | `/cleanup/ignores?localSourcePolicy=&resolved=&limit=&offset=` | 独立管理视图（含归档/回收站）；`resolved` 按请求策略单条求值。 |
| POST | `/cleanup/ignore` `{itemId,rule,note?}` | 幂等 upsert；返回行的 `resolved` 是 include_local 视图，需按所选策略重拉。 |
| DELETE | `/cleanup/ignore/:itemId/:rule` | 恢复 = 删忽略行；幂等 `{removed:0\|1}`，不 404。 |
| GET | `/cleanup/filters` | `{filters[]}`。 |
| POST | `/cleanup/filters` `{name,filter}` | 201；`filter.localSourcePolicy` 必填；同名 409。 |
| PATCH | `/cleanup/filters/:id` `{name?,filter?,expectedVersion}` | name-only 不要求策略；替换 filter 必须自带策略；CAS 失败/同名 409。 |
| DELETE | `/cleanup/filters/:id` | 幂等 `{deleted:0\|1}`。 |

### 合并条目的事务扩展

`POST /items/merge` 的响应在既有字段外追加 `loadoutMerge`（`{conflicts,revived,moved,bothTombstone,noop}`）
与 `cleanupIgnoresMoved`（数字）。清单成员与整理忽略的迁移与资产/版本关系迁移在**同一事务**内完成：
任一环节失败（CAS 0 行、审计写入失败、触发器 ABORT）整体回滚。
