# 扫描变更中心（M1）—— 持久化预览与应用

> 目标：把"扫一下看看会发生什么"从**摘要**升级为**可确认的清单**：先落库、逐条展示新增/变化/缺失，
> 用户勾选后再应用。只做登记/索引/标记缺失，**不移动、不删除原始文件，也不自动合并重复项**。

## 1. 为什么不复用 dryRun

`POST /api/scan {dryRun:true}` 只是"扫到多少文件"的摘要：不知道哪些已入库、哪些变了、哪些会标缺失，
也不支持确认后只应用一部分。两者并存：dryRun 保留（快速预览），变更中心是新的持久化流程。

## 2. 数据模型（schema v4）

| 表 | 作用 |
|---|---|
| `scan_previews` | 一轮扫描 = 一条预览：范围（path/deep）、状态、planHash、完整性（truncated/complete/errorCount）、计数、TTL |
| `scan_preview_items` | 逐条变化：`change`（new/unchanged/changed/missing/duplicate_suspected/unreadable/error）、size/mtime 与上一次的对照、关联 asset/item、用户的 decision、应用结果 |
| `scan_preview_errors` | 遍历/解析/应用阶段的错误明细（带 stage），与预览绑定 |
| `scan_apply_runs` | 每次 apply 的批次：requested/applied/failed/stale/skipped、幂等键、job 关联 |

关键约束：

- `ux_preview_active(path_norm, deep) WHERE state IN ('scanning','ready','partial','applying')`：同参数只允许一个活跃预览（重复创建直接返回它）。
- `ux_preview_item(preview_id, item_key)`，`item_key = path_norm`：预览内路径唯一。
- 预览条目**不建外键**到 items/assets（软删/合并后历史预览仍可读），只存 id 快照。

## 3. 状态

```
scanning ─┬─ ready     （complete=1：未截断、无读取错误、根可读）
          ├─ partial   （有缺口：截断/读取错误；**不提出 missing 项**）
          └─ failed    （根目录不可读）

ready/partial ─┬─ applying ─┬─ applied            （全部成功）
               │            ├─ partially_applied  （部分成功，可 retry）
               │            └─ failed
               ├─ cancelled
               └─ expired   （TTL 24h；过期不可 apply，只能重新扫描）
```

## 4. 变化类型与判定

| change | 判定 | 默认可应用 |
|---|---|---|
| `new` | 库里没有任何资产占用该 path_norm | ✅ |
| `unchanged` | 已存在且 size + mtime 与预览一致 | ✖（无事可做） |
| `changed` | 已存在但 size 或 mtime 变了 | ✅（重新索引） |
| `duplicate_suspected` | 新文件，但存在**同名 + 同尺寸**的已有资产 | ✅（只是提示，绝不自动合并） |
| `missing` | 已登记资产在本轮**完整**扫描里没出现 | ✅（用户确认后才标） |
| `unreadable` | 目录里有这个条目但 stat 失败 | ✖ |
| `error` | readdir 失败等遍历错误 | ✖ |

- **同名不构成重复**：只有"同名 + 同尺寸"才给疑似提示，且从不自动合并。
- **判缺沿用 M0 门控**：`truncated` / `errorCount>0` / 根不可读 / 空树 → 不提出 missing（把"没看到"当"没了"是最危险的误判）。

## 5. 应用（apply）安全规则

1. 只接受 `ready|partial`；`applying` → 409；已过期 → 410（并写 expired）。
2. 可带 `planHash`：与预览不一致 → 409 `STALE_PREVIEW`。
3. 可带 `idempotencyKey`：同键重复提交返回同一批次（不重复写库）。
4. **应用前逐条重新 stat**：文件消失 / size / mtime 变化 → 标 `stale`（写进条目 error，不写库）；
   `missing` 项若文件又出现 → 同样 stale（不再标缺失）。
5. 只应用 `decision='accept'` 且 `applied=0` 的条目；已成功项不会二次写入。
6. 每批仍走**同一条建档管线**（scan job 的显式文件列表）：建条目 → 登记资产 → 索引 → 匹配 → 分类。
   因此 BOOTH 识别、头像匹配、分类推荐、哈希/包索引全部与普通扫描一致。
7. 失败可单项重试（`/retry` 只挑 `applied=0 且有 error` 的条目）。
8. 全程不移动/删除原始文件；`missing` 只是数据库状态（可被下一次完整扫描恢复为 present）。

## 6. API

```
POST   /api/scan/previews                     {rootId?|path, deep?} → 202 {previewId, state, jobId} | 200 {existing:true}
GET    /api/scan/previews?limit=              预览列表（自动把过期项标 expired）
GET    /api/scan/previews/:id                 { preview{counts,itemCounts,scan,plan_hash,…}, applies[], errors[] }
GET    /api/scan/previews/:id/items?cursor&limit&change    keyset 分页
POST   /api/scan/previews/:id/items           {keys[] | change, decision:'accept'|'skip'|'pending'}
POST   /api/scan/previews/:id/apply           {planHash?, mode:'all'?, itemKeys[]?, idempotencyKey?} → 202
POST   /api/scan/previews/:id/cancel          → cancelled（applying 时 409）
POST   /api/scan/previews/:id/retry           → 只重试失败项 → 202
DELETE /api/scan/previews/:id                 → {deleted}（applying 时 409；级联删条目）
```

## 7. 已知边界

- `size + mtime` 只是**元数据指纹**：内容变了但 size/mtime 被刻意保持不变时，首版检测不到（不做额外哈希，避免 IO 放大）。
- 预览 TTL 24h，过期需重新扫描（不做"自动续期"，避免用旧快照写新状态）。
- 预览的 `missing` 只是"建议"，默认不勾选；用户勾选才会写 missing。
- 没有"撤销 apply"：apply 只做登记/索引/缺失标记，素材文件本身没动，可手工回滚（把资产标 present / 删条目）。
- 单写者约束未在本阶段解决：同一个 dataDir 起两个服务仍然不安全（沿用既有单实例锁约定）。

## 8. 验证

```bash
node --import tsx --test test/scan/preview.test.ts     # 12 项单测：schema/分类/重验/幂等/过期/级联
node --import tsx scripts/acceptance-scan-preview.mjs  # 21 项端到端（临时库 + 真实 zip）
```
