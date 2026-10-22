# v0.7.1 独立验收明细（task-55）

> 自动生成：`node --import tsx scripts/acceptance-v071.mjs`；2026-10-22T11:48:22.746Z
> 结果：**PASS**（PASS 42 / FAIL 0 / SKIP 0 / BLOCKED 2）
> BLOCKED = 本环境无法自动化（真实 Unity / Windows 生产卷），不计入 strict 失败。
> 全部使用 os.tmpdir() 临时 SQLite 与临时 staging；未访问生产 data。

| ID | 区域 | 断言 | 结果 | 证据/备注 |
|---|---|---|---|---|
| S1 | SCHEMA | v9：import_plans.risk_json/risk_state + import_runs.verification_scope/checked_count/expected_count 存在 | PASS | plan=risk_json,risk_state run=verification_scope,checked_count,expected_count |
| S2 | SCHEMA | staging_files 台账表存在（v9） | PASS | tables=staging_files |
| S3 | SCHEMA | migrate 幂等（连续两次执行版本一致） | PASS | version=9→9 (SCHEMA_VERSION=9) |
| R0a | RISK | 风险夹具解析出可导入单元（前置） | PASS | risky.unitypackage:single_unitypackage:imp=1 |
| R0b | RISK | applyPlanRisk 落库 risks（scannerVersion/digest/hits/state） | PASS | {"v":2,"digest":"60d8d46cdf45","state":"warning","hits":4} |
| R1 | RISK | .cs → hits 含 code/editor_code；计划进入 needs_confirmation（或 blocked） | PASS | types=assembly,code,editor_code,asmdef state=warning status=needs_confirmation |
| R2 | RISK | .dll → hits 含 assembly | PASS | types=assembly,code,editor_code,asmdef |
| R3 | RISK | Editor/ 下 .cs → 单独归为 editor_code | PASS | types=assembly,code,editor_code,asmdef |
| R4 | RISK | .asmdef → hits 含 asmdef 且 severity=info | PASS | {"path":"Assets/Data/Evil.asmdef","type":"asmdef","reason":".asmdef/.asmref 会改变程序集与编译边界","severity":"info"} |
| R5 | RISK | 大小写/反斜杠（ASSETS\\EDITOR\\Bad.CS、.DLL）→ editor_code + assembly | PASS | types=assembly,editor_code |
| R6a | RISK | scanPaths+magic：pdf→PK / png→MZ 判 disguised；zip→PK、pdf→%PDF 不误报 | PASS | pdf=["disguised"] png=["disguised"] zip=[] realPdf=[] |
| R6b | RISK | computePlanRisk 接 magic：真实 .pdf（内容 zip）→ disguised | PASS | state=warning types=["disguised"] path=/tmp/av-v071-6IEkQy/fixtures/disguised_container.pdf |
| R7 | RISK | 损坏包 → 无可导入单元（unknown/limited，不伪造成功） | PASS | unknown_structure:failed:imp=0 |
| R8 | RISK | unknown/limited 单元建计划被拒（INVALID_INPUT） | PASS | code=INVALID_INPUT |
| R9 | RISK | blocked 风险计划 confirm → RISK_BLOCKED（即使 ack 也不放行） | PASS | code=RISK_BLOCKED |
| R9b | RISK | blocked + riskAck=true 仍 → RISK_BLOCKED（风险阻断不可确认） | PASS | code=RISK_BLOCKED |
| R10a | RISK | warning 计划未 ack → RISK_REQUIRES_ACK | PASS | code=RISK_REQUIRES_ACK |
| R10b | RISK | riskAck 后 → ready 且 risk_json 记 risk_ack_at/risk_ack_digest | PASS | status=ready ackAt=2026-10-22T11:48:22 digest=digest-x |
| P1 | PLAN | 干净单包计划建立（ready） | PASS | ready |
| P2 | PLAN | 指纹变化 → FINGERPRINT_CHANGED 且计划 blocked | PASS | code=FINGERPRINT_CHANGED |
| U1 | UNKNOWN | 正常执行完成且只发出 1 次 ImportPackage | PASS | run=partial_success importCalls=1 items=partial_success |
| U2 | UNKNOWN | 已执行计划不可二次执行（无第二次外部导入） | PASS | code=PLAN_NOT_EXECUTABLE importCalls=1 |
| U3 | UNKNOWN | run_items 全部终态（无 importing 半开） | PASS | failed |
| G1 | STAGING | 台账 path_norm 唯一（同路径重复登记 → 1 行、size 更新） | PASS | id=1 size=32 |
| G2 | STAGING | 台账状态/重试计数可更新 | PASS | cleanup_pending/1 |
| G3 | STAGING | stale 查询按 last_used_at 截止（未来 cutoff → 命中） | PASS | rows=1 |
| G4 | STAGING | 台账行可删除 | PASS |  |
| G5 | STAGING | cleanupStagingForRun(failed/unknown) 保留台账与文件（供 7 天 sweep） | PASS | {"removed":0,"failed":0,"kept":1} |
| G6 | STAGING | cleanupStagingForRun(verified/partial_success) 删文件 + 删台账 | PASS | {"removed":1,"failed":0,"kept":0} |
| G7 | STAGING | 执行结束无 in_use 残留（cleanupStagingForRun 已执行） | PASS | run=1 status=partial_success left=[] |
| G8 | STAGING | sweepStaging dryRun 只报告不删（文件/台账保留） | PASS | {"candidates":1,"removed":0,"failed":0,"skipped":0,"errors":[]} |
| G9 | STAGING | sweepStaging 过期清理（删文件 + 删台账） | PASS | {"candidates":1,"removed":1,"failed":0,"skipped":0,"errors":[]} |
| G10 | STAGING | 越界路径不删（stagingDir 之外）且记 skipped/errors | PASS | {"skipped":1,"errors":["越界路径，拒绝清理: /tmp/av-v071-6IEkQy/outside-sweep.bin"]} |
| G11 | STAGING | 活跃执行中的 staging 不清理（run.status=running） | PASS | {"skipped":2,"removed":0} |
| G12 | STAGING | 符号链接拒绝清理（lstat isSymbolicLink） | PASS | ["越界路径，拒绝清理: /tmp/av-v071-6IEkQy/outside-sweep.bin","符号链接，拒绝清理: /tmp/av-v071-6IEkQy/sweep/u3/link.unitypackage"] |
| G13 | STAGING | 路由 GET /api/staging 与 POST /api/staging/cleanup 存在（源码 + bundle） | PASS | src=true/true bundle=true |
| B1 | BUILD | bundle 与 schema.sql 产物存在 | PASS | /root/Code/asset-vault/apps/desktop/build/server.mjs |
| B2 | BUILD | bundle 含 v0.7.x 路由标记（/api/import-plans、/api/import-runs） | PASS | import-plans=true import-runs=true |
| B3 | BUILD | 构建产物 schema.sql 与源码 byte-equal | PASS | identical |
| B4 | BUILD | scripts/verify-build.mjs 通过（bundle/路由/version/sha256/schema） | PASS | status=0   [PASS] B5 build-info.commit 与 HEAD 一致 — build=3e93612f0c head=3e93612f0c / BUILD OK (6 checks) |
| M1 | MACHINE | importing→unknown 允许；unknown 终态（→verified 抛 INVALID_TRANSITION） | PASS | code=INVALID_TRANSITION |
| M2 | MACHINE | cancelled 终态（→verified 抛 INVALID_TRANSITION） | PASS | code=INVALID_TRANSITION |
| X1 | UNITY | 真实 Unity ImportPackage 端到端（AssetDatabase 实际导入 / 控制台 / GUID 验证） | BLOCKED | MCP 离线，沿用 v0.7.0 UNVERIFIED；需在 Windows + Unity Editor 跑 scripts/acceptance.sh 或 scripts/win-acceptance.cmd |
| X2 | UNITY | Windows 生产卷上的 staging 磁盘峰值（F8） | BLOCKED | 本机 tmpfs 不能代表 NTFS 配额/磁盘压力；需在准生产环境测 |

