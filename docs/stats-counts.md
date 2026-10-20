# stats / health.counts 口径（v0.6.1 FIX-03）

两个端点返回同一份 `repo.stats()` 快照：

- `GET /api/stats` → stats 对象本身；
- `GET /api/health` → `{ ok, version, dbPath, roots, counts: stats }`。

因此 `counts` 与 `/api/stats` 必须逐字段 deepEqual（测试：`test/http/health-stats.test.ts`）。

## 字段语义（当前实现，FIX-03 不改语义）

| 字段 | SQL 口径 | 说明 |
| --- | --- | --- |
| `items` | `items WHERE status<>'trashed'` | 不含回收站条目 |
| `assets` | `assets WHERE status<>'trashed'` | **含 `missing` 资产**；不 JOIN items |
| `bytes` | `SUM(size) FROM assets WHERE status<>'trashed'` | 与 `assets` 同一集合（含 missing） |
| `missing` | `assets WHERE status='missing'` | 不 JOIN items（条目已回收但资产行仍 missing 时仍计数） |
| `avatars` | `COUNT(*) FROM avatars` | 全量头像 |
| `inbox` | `items WHERE status='inbox'` | 待确认条目 |
| `byCategory` | items 非 trashed 按 category_name 分组 | 最多 40 组 |
| `byAvatar` | avatars JOIN item_avatars JOIN items（非 trashed） | 最多 60 组 |

## 已知不自洽（记录，不在 FIX-03 修改）

- `assets`/`bytes` 不 JOIN `items`：条目已进回收站时其资产仍被计数，但 `items` 已排除。
- `missing` 不 JOIN items，与 `assets` 的 missing 子集口径一致（都是资产行）。
- 快照不包含 jobs/trashed 等维度；需要作业信息请查 `/api/jobs`、`/api/jobs/stats`。

若后续要改变语义（例如 assets 也 JOIN items），必须先更新本文件与 `/api/stats` 的 deepEqual 测试，保持两端点一致。
