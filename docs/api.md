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

## 资产 / 内容
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/assets/:id` | AssetRow + 该资产的 avatar 关联 |
| GET | `/assets/:id/tree` | `{container, entries: ArchiveEntry[]}`（zip/7z/rar 按需列目录并缓存） |
| GET | `/assets/:id/unitypackage` | `{assets: UnityPackageAsset[]}`（不启动 Unity） |
| GET | `/assets/:id/entry?path=` | 从压缩包内直读单个文件（图片/文本预览） |
| POST | `/assets/:id/reindex` | 重列目录/重解析 → `{jobId}` |

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
