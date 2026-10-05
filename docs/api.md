# AssetVault HTTP API（FROZEN v1）

Base: `http://127.0.0.1:7317/api`。所有响应 JSON；错误：`{ "error": { "code": AppErrorCode, "message": string } }` + 对应 HTTP 状态
（400 INVALID_INPUT / 404 NOT_FOUND / 409 INVALID_TRANSITION|CONFLICT / 502 UPSTREAM_ERROR / 401 LOGIN_REQUIRED）。

## 条目
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, version, dbPath, roots, counts}` |
| GET | `/items?q=&avatar=&avatarMatch=any|all&ownedOnly=&site=&status=&tag=&container=&imported=1|0&sort=updated|title|size&limit=&offset=` | `{total, items: ItemCard[]}`；`q` 为 FTS5 trigram 子串（<3 字符回退 LIKE），`avatar` 支持逗号分隔多值 |
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
| GET/POST | `/tags`，POST `{name, namespace?, color?}` | |
| GET/POST | `/projects`，POST `{name, path}` | Unity 工程 |
| POST | `/projects/:id/imports` `{itemId, assetId?}` | 记录"已导入" |
| GET | `/media/:imageId?w=` | 缩略图/原图字节（sharp 生成缓存） |
| GET | `/stats` | `{items, assets, bytes, avatars, byCategory[], byAvatar[]}` |
| GET | `/export/items.json` | 全量导出 |
| GET | `/unity/status` | Unity 桥探测（连不上也是 200） |
| GET | `/unity/packages?itemId=` | 可导入的 .unitypackage 清单 |
| POST | `/unity/import` `{itemId, keys?}` | **真导入**到当前打开的 Unity 工程 |

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

## 媒体
`GET /media/:imageId` 直接返回缩略图（webp，最长边 512）；原图缺失时才回退原文件。可直接作 `<img src>`。
