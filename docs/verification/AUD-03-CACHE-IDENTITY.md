# AUD-03 弱身份缓存对抗（v0.6.1，只读）

- 基线：b77ea2f（审计开始时工作树仅 “asset-vault - 快捷方式.lnk” 未跟踪）
- 方式：只读代码审计 + **一次性 SQLite 临时库 + 临时目录**跑真实 stage/Repo/DerivedCache（无桩替身）；**未改实现代码、未触碰生产 data**
- 脚本：scripts/audit-cache-identity-adversarial.ts（新增，可重复执行）；日志 logs/audit-03-adversarial.log
- 新增测试：test/pipeline/cache-identity.test.ts 追加 1 条（scan 重置 → 强身份失效），现 **18/18 pass**
- 复现：node --import tsx scripts/audit-cache-identity-adversarial.ts（--json 出机器可读矩阵）

## 0. 结论摘要

| 编号 | 场景 | 判定 | 一句话 |
|---|---|---|---|
| S1 | 跨资产、同 size+mtime、内容不同 | SAFE | 弱键含 assetId:path_norm，两个资产不可能撞键 |
| S2 | rename 替换（新 inode，同 size+mtime） | SAFE | ino 变化 → 键变 → miss |
| S3 | Node cpSync 覆盖 | SAFE | Node 实现是“新 inode 替换”，等于 S2 |
| S3b | GNU cp -p 覆盖（就地写，同 inode/size/mtime） | **VULN** | 命中旧目录（磁盘真实 b1.txt，缓存给 a1.txt） |
| S4 | 原地写 + utimes 回写 mtime（同 inode） | **VULN** | 与 S3b 同类，只是不经过 cp |
| S5 | 陈旧 sha 窗口（同 size+mtime 替换后 scan 不重置 sha） | **VULN** | 强身份仍成立（weak=false），命中旧目录 |
| S6 | 强键污染（条目被清后重算） | **VULN** | 新内容被写进旧 sha 的键 |
| S6b | 污染的跨资产后果 | **VULN** | 真正拥有旧 sha 内容的资产读到别人的目录 |
| S7 | 强身份同内容跨路径复用 | SAFE | 只解析一次、只写一条缓存，两边条目正确 |
| S8 | ino/dev 退化（模拟 Windows ino=0） | **VULN** | 同一资产原地替换时弱键无法区分 |
| S9 | inode 复用（tmpfs） | SAFE | tmpfs 顺序分配，8/8 不复用 |
| S9b | inode 复用（ext2/3，工作区文件系统） | **VULN** | 删后重建**立即复用 inode**（7/7 相同），ino 守卫失效 |
| S10 | scan 重置窗口（同 size+mtime → scan 判 unchanged） | **VULN** | sha 保持 ok，强键继续命中旧目录 |
| S11 | 对照：mtime 变化 → scan 重置 sha | SAFE | sha256=NULL / state=pending → 弱身份 → 不命中 |

汇总（修复前基线）：14 条，SAFE 6 / VULN 8。**跨资产弱键混用不可能**；但“同路径、同 size+mtime 的内容替换”在 4 种替换方式下可复现错误，且能升级为强键污染（S6/S6b）。

> **FIX-05（task-33）已修复并复测：14/14 SAFE、VULN 0** —— 见 §10（内容采样 sample 参与 cacheKey）。下面 §2~§5 是修复前基线，保留作对照。

## 1. 代码现状（与实现逐条对账）

- 弱身份：stages.ts:97-101 —— weak:<assetId>:<path_norm>:<size>:<mtimeMs>[:<ino>:<dev>]，ino/dev 仅在 >0 时追加。
- 强身份三条件：stages.ts:90 —— sha256_state==='ok' 且 live.size===row.size 且 |mtime|<=2ms（stages.ts:60-73 的 MTIME_TOLERANCE_MS=2 + liveMatchesRow）。
- 命中校验：cache.ts:103-104 —— 传了 expect.contentSha 且与条目 content_sha 不符 → drop+miss；stages.ts:188/235 只对强身份传。
- 扫描重置：scan.ts:399 只比较 size/mtime → repo.ts:376-382 仅在**二者之一变化**时把 sha 置 NULL/pending。
- 弱标记：cache_entries.weak（schema.sql:423-424，v6）+ cache.ts put 透传（未迁移库 try/catch 降级）。

## 2. 逐项证据（脚本输出摘录）

- S3b：ino 45->45 size=210 磁盘真实=[b1.txt] 缓存=[a1.txt]
- S4：entries=[a1.txt]（文件已是 B 内容）
- S5：identity=sha256:999… weak=false 真实内容应为 b1.txt 缓存=[a1.txt]
- S6：reparsed=true 旧 sha 键下现在存的是=[b1.txt]（该 sha 对应旧内容 a1.txt）
- S6b：命中=true 该资产真实条目=[a1.txt] 实际写入=[b1.txt]
- S9b：inos=[65946 ×8] 复用次数=7（ext2/3；/tmp 的 tmpfs 为 0）
- S10：sha被重置=false sha_state=ok entries=[a1.txt]
- S11：sha被重置=true sha_state=pending（对照，证明重置逻辑本身有效）

## 3. ctime 探针（建议的最便宜修复方向，仅测量未改实现）

用 ns 精度比较替换前后 ctimeNs（logs/audit-03-adversarial.log 末尾）：

| 替换方式 | ctime 变 | mtime 变 | ino 变 |
|---|---|---|---|
| cp -p 覆盖（就地） | **是** | 否 | 否 |
| 原地写 + utimes 回写 mtime | **是** | 否 | 否 |
| 删后重建 | **是** | 否 | 是 |

结论：ctime 是唯一在三种替换下都变化的廉价信号（且用户无法 set）；把它纳入弱键（或纳入 scan 的 changed 判定）可一次性关掉 S3b/S4/S9b/S10。代价是 chmod/utimes/rename 等元数据操作会让弱缓存失效（只多解析一次，不影响正确性）。

## 4. ino/dev 平台可得性

- Linux（本机实测）：ino>0 && dev>0（/tmp tmpfs 与工作区 ext2/3 均有效）→ 弱键带 :ino:dev。
- **但** ext2/3 上“删后重建”会立刻复用 inode（S9b 7/7）→ ino 只能挡“换 inode 的替换”（rename / Node cpSync / cp 到新路径），挡不住删后重建 + 同 size+mtime。
- Windows：本轮 Linux 环境**无法实测**；实现按 ino>0 && dev>0 才追加，Windows 若返回 0 则退化为不含 ino 的格式（S8 给出该退化形态的确定性证据）。建议在 Windows 生产机跑一次：
  node -e "const s=require('fs').statSync('某个.zip',{bigint:true});console.log({ino:String(s.ino),dev:String(s.dev),ctime:String(s.ctimeNs),mtime:String(s.mtimeNs)})"
  替换该文件后重跑，比较 ino/ctime 是否变化；若 ino 恒 0，则 Windows 侧只能依赖 ctime + 内容抽样。

## 5. 影响与触发路径

1. 同 size+mtime 替换**不会被扫描发现**（scan.ts:399）→ 不会自动重新入队，DB 里的旧派生数据保持旧值（静默陈旧）。
2. 一旦触发重解析（POST /api/pipeline/assets/:id/reindex（routes.ts:966）、POST /api/assets/:id/reindex（routes.ts:585）、重建/全量重索引），才会走到 S3b/S4/S5 的命中分支。
3. 命中后 stages.ts:159 applyArchiveListing 把旧条目写进当前资产行 → /api/assets/:id/tree（routes.ts:489+）直接展示错误目录；stageThumbs（stages.ts:242-250）按错误路径读条目 → NOT_FOUND 计数；去重签名基于错误条目。
4. S6/S6b 是持久污染：错误结果被写进**旧 sha 的键**，直到该条目被 GC/清理；期间任何真正拥有该 sha 内容的资产都会读到别人的目录。

## 6. 与 v0.6.1 报告的一致性

- V0.6.1-REPORT.md:19 “G7 缓存身份 ✅ 17/17（cache-identity）”与基线一致（本轮新增 1 条后为 18/18）。
- 报告只写了“缓存 weak 标记”（:45/:47/:49），**没有**记录弱键格式、ino/dev 守卫、以及“同 size+mtime 替换无法识别”这一残差 —— 建议补一段“已知残差”。

## 7. 修复建议（按性价比，供 v0.6.2 排期；本轮未改实现）

| 优先级 | 建议 | 能挡住 | 代价/风险 |
|---|---|---|---|
| P0 | 弱键追加 ctimeNs（contentIdentity 一处）；scan/upsertAsset 的 changed 判定加入 ctime（需 assets 加列或写进 content_version） | S3b/S4/S9b/S10 | 元数据操作会让弱缓存失效（多一次解析）；schema 加列需迁移 |
| P0 | 强身份也做内容抽样校验：缓存 meta 增 verify（前 64KB+尾 64KB 的 sha256），命中时比对；解析写缓存时一并写入 | S5/S6/S6b | 每次命中读 ~128KB（1-3ms），可按限制开关 |
| P1 | Windows 身份策略：ino 不可用时用 ctime+size+mtime；诊断里标注身份等级（strong / weak-ino / weak-noino） | S8 降级可见 | 仅诊断成本 |
| P2 | 弱条目 TTL（如 7 天）+ “命中即抽样复核”（低概率抽样重算） | 兜底 | 轻微 CPU |
| P3 | 文档：把弱键语义与残差写进 V0.6.2 报告 | — | — |

## 8. 复现命令

```bash
# AUD 矩阵（人读）
node --import tsx scripts/audit-cache-identity-adversarial.ts
# AUD 矩阵（机器读）
node --import tsx scripts/audit-cache-identity-adversarial.ts --json
# 身份回归测试（18 条）
node --import tsx --test test/pipeline/cache-identity.test.ts
```

## 9. 边界

- 未验证 Windows 的 stat.ino / ctimeNs 语义（本机 Linux）；已给出实测命令。
- 未注入网络盘（SMB）/ OneDrive 占位文件场景；若库在 SMB 上，ino/dev 语义可能不同，建议另测。
- 未测“跨设备搬迁”（dev 变 → 弱键变 → 必然重解析，安全方向）。
## 10. FIX-05（task-33）修复后复测（2026-10-21）

**实现**：stages.ts 新增 contentSample(file, sizeHint) = sha256(head 64KiB + tail 64KiB + size) 前 16 hex；
sample 写进 archive-listing / upkg-listing 的 cacheKey.extra（强/弱身份都加）。
sample 不可读（读失败 / 采样期间文件被替换 / 读不满）→ 返回 null → **绕过缓存**（不 get 不 put），
note 追加 “sample unreadable (cache bypassed)”。强身份命中仍保留 expect.contentSha 校验。

**复测**（同一脚本，logs/audit-03-adversarial.log）：14 条全部 SAFE。原 8 条 VULN 的转归：

| 原 VULN | 修复后 | 机制 |
|---|---|---|
| S3b cp -p 就地覆盖 | MISS | sample 变 → 键变 |
| S4 原地写 + utimes | MISS | 同上 |
| S5 陈旧 sha 窗口 | MISS | 同上（强身份键也带 sample） |
| S6 强键污染 | 旧键不被覆盖 | 新内容进“旧 sha + 新采样”的独立键 |
| S6b 污染的跨资产后果 | 正确（a1.txt） | 同上 |
| S8 Windows ino=0 | 键级可区分 | identity 不可区分，但 sample 让键不同 |
| S9b ext2/3 inode 复用 | MISS | sample 变 → 键变 |
| S10 scan 重置窗口 | MISS | sample 变 → 键变 |

**成本（500 文件，--bench，logs/audit-03-bench.log）**：

- 冷启动：500 解析 / 691 ms（1.38 ms/资产）
- 热命中：500/500（100%）/ 422 ms（0.84 ms/资产）；采样单项 189 ms（0.38 ms/资产），不含采样的估算 0.47 ms/资产
- 替换混合（50 个 cp -p 就地替换）：450 命中 + 50 重解析、**wrongDirs=0**、407 ms（0.81 ms/资产）
- 对照（修复前）：同一混合会 500/500 命中，但其中 50 条目录错误

**有意行为变化**：同 sha 但字节不同的（伪造/陈旧 sha）现在会 MISS —— 这是期望的防御，原“同 sha 共享”测试已改为真同内容。

## 11. 独立复跑（verifier，2026-10-21，FIX-05 工作树）

- 命令：`node --import tsx scripts/audit-cache-identity-adversarial.ts`（同一脚本、同一一次性临时库；实际写入 `/tmp/aud03-fixtures-*`）。
- 结果：**14 条 / SAFE=14 / VULN=0**，与 §10 一致；S3b/S4/S5/S6/S6b/S8/S9b/S10 全部 MISS 或旧键不被覆盖；S7/S9/S11 对照保持预期。
- 原始日志：`logs/audit-cache-identity-fix05.log`（本次）；矩阵原日志 `logs/audit-03-adversarial.log`。
- 代价抽样（脚本 --bench，core-content 已测）：500 资产冷 1.38ms/资产、热 0.84ms/资产、混合替换 0.81ms/资产且 wrongDirs=0。
- 回归测试：`test/pipeline/cache-identity.test.ts` 24 条，全量 `node scripts/test.mjs` = 687/664/0 fail（`logs/fixall-tsc-tests.log`）；`tsc --noEmit` = 0。

