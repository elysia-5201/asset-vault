# v0.7.0 结构验收明细（task-40）

> 自动生成：`node --import tsx scripts/acceptance-structure.mjs`；2026-10-21T15:50:48.453Z
> 结果：**PASS**（PASS 54 / FAIL 0 / SKIP 0）

## 夹具（真实 zip / tar.gz，含 asset.meta guid）

| 文件 | 大小 | sha256 |
|---|---|---|
| A_multi_container.zip | 1351 | `978676a388296b19e1ef4a0af8b1a6b2…` |
| B_mixed.unitypackage | 381 | `9d7e4cd9d8891263747422c7f5ddeaa3…` |
| C_container_mixed.zip | 542 | `9cbc7c3320efd3ac3c694f6d710cb186…` |
| D_companion.zip | 1268 | `f12c104e5be4929f882528e1e783994d…` |
| E1_corrupt.zip | 126 | `faac88191b7a64cbb658816526fa8e13…` |
| E2_truncated.unitypackage | 199 | `5b3b5d6b2017d255f451b741b7989093…` |
| E3_overlimit.zip | 6671 | `980a22792d19db310c3ab97fa2a2ca90…` |
| E4_zipslip.zip | 514 | `10b30dfbc33e7435bec9fde229ac37ef…` |
| E5_depth4.zip | 741 | `b24f5614c4a75411d51eea08b2d6671d…` |
| E5_nested3.zip | 560 | `5c7ab59220d9698c95bb119058c5a9fa…` |

## 明细

| ID | 区域 | 断言 | 结果 | 证据/备注 |
|---|---|---|---|---|
| A-1 | A | listArchive(zip) 成功、container=zip | PASS | entries=4 |
| A-2 | A | 识别 3 个独立 .unitypackage + 1 个说明.pdf | PASS | MANUKA_clothing/MANUKA.unitypackage \| MANUKA_materials/MANUKA_mat.unitypackage \| OTHER_AVATAR/Kikyo.unitypackage |
| A-3.1 | A | 条目可独立提取并解析（MANUKA_clothing/MANUKA.unitypackage） | PASS | assets=1 assetPath=Assets/Manuka/Manuka_body.fbx |
| A-3.2 | A | 条目可独立提取并解析（MANUKA_materials/MANUKA_mat.unitypackage） | PASS | assets=1 assetPath=Assets/Manuka/Manuka_body_MAT.mat |
| A-3.3 | A | 条目可独立提取并解析（OTHER_AVATAR/Kikyo.unitypackage） | PASS | assets=1 assetPath=Assets/Kikyo/Kikyo_body.fbx |
| A-4 | A | A 的 3 个包各自单 Avatar、可独立选择（可选） | PASS | units=3 |
| B-1 | B | 单个 upkg 解析出 2 个资产路径（Manuka + Kikyo） | PASS | Assets/Manuka/Manuka_body.fbx \| Assets/Kikyo/Kikyo_body.fbx |
| B-2 | B | B 是单文件、不可拆分（结构事实） | PASS | 同一 upkg 内 2 个 Avatar |
| C-1 | C | 外层 zip 只有 1 个 upkg 条目 | PASS | entries=1 |
| C-2 | C | 内部包解析出 2 个 Avatar（混合），外层不得当 multi 拆 | PASS | Assets/Manuka/Manuka_body.fbx \| Assets/Kikyo/Kikyo_body.fbx |
| D-1 | D | 3 个独立 upkg（模型/材质/贴图）均单资产 | PASS | MANUKA_model/MANUKA_model.unitypackage \| MANUKA_material/MANUKA_material.unitypackage \| MANUKA_texture/MANUKA_texture.unitypackage |
| D-2 | D | D 的资产路径同属一个 Avatar（Manuka），无跨 Avatar 混入 | PASS | Assets/Manuka/Manuka_body.fbx \| Assets/Manuka/Manuka_body_MAT.mat \| Assets/Manuka/Manuka_TEX.png |
| E1 | E | 损坏 zip → 解析抛错（不返回伪造结果） | PASS | code=NOT_AN_ARCHIVE |
| E2 | E | 截断 upkg → 抛错或明确 truncated（不伪造完整） | PASS | code=NOT_AN_ARCHIVE |
| E3-1 | E | 条目数 > maxEntries → truncated + limited ENTRIES | PASS | entries=50 limited={"code":"ENTRIES","message":"stopped at maxEntries=50"} |
| E3-2 | E | 单条目 2048B > maxEntryBytes=1024 → limited BYTES（仍列出目录） | PASS | limited={"code":"BYTES","message":"entry huge.bin declared 2048 > maxEntryBytes 1024"} |
| E4-1 | E | zip-slip 条目在目录层被剔除（不暴露越界路径） | PASS | entries=["ok/readme.txt"] |
| E4-2 | E | 显式读取越界条目被拒绝（不存在/非法输入） | PASS | code=NOT_FOUND |
| E4-3 | E | 若路径逃逸，isSubPath 可判定（防御对照） | PASS | normalized=../../../evil.unitypackage |
| E5-1 | E | 嵌套 3 层可逐层解出 upkg | PASS | depth=3 assets=1 |
| E6-1 | E | 文件被改后 sha256 变化（指纹可检出） | PASS | 9d7e4cd9d8891263 -> b7be4142702a3f2f |
| E6-2 | E | 被改后的文件不再被当作完整包（抛错或 truncated/assets 变化） | PASS | code=NOT_AN_ARCHIVE |
| G-1 | G | 全部夹具解析后原始 sha256 / mtime 不变（解析只读） | PASS |  |
| P-7 | POLICY | evidence：别名/大小写/全半角命中并被合并 | PASS | [{"avatarId":1,"via":"filename","level":"probable","hits":["MANUKA.unitypackage","マヌカ","ＭＡＮＵＫＡ"]}] |
| P-8 | POLICY | evidence：item_avatar 视为 confirmed | PASS | [{"avatarId":1,"via":"item_avatar","level":"confirmed","hits":["item_avatar:1"]}] |
| P-1 | POLICY | A：zip 内 2+ 独立 upkg → multi_package_container | PASS | {"policy":"multi_package_container","reason":"外层 zip 内含 3 个独立 unitypackage（逐包处理，不整体当混合包拆）"} |
| P-2 | POLICY | B：单个 upkg 混合 2 Avatar → mixed_unitypackage | PASS | {"policy":"mixed_unitypackage","reason":"证据显示支持 2 个不同模型（≥2）"} |
| P-3 | POLICY | C：zip 内只含混合包 → mixed（不是 multi） | PASS | {"policy":"mixed_unitypackage","reason":"证据显示支持 2 个不同模型（≥2）"} |
| P-4 | POLICY | E1：损坏/失败解析 → unknown | PASS | {"policy":"unknown_structure","reason":"压缩包解析失败，无法判断内部是否含 unitypackage"} |
| P-5 | POLICY | E5：无直接 upkg（仅深层嵌套）→ unknown | PASS | {"policy":"unknown_structure","reason":"zip 内未发现 unitypackage，不是 Unity 包容器"} |
| P-6 | POLICY | D：模型/材质/贴图同 stem → suggested_companion/probable（无 confirmed） | PASS | observedTypes=["suggested_companion","suggested_companion","suggested_companion"] |
| P-9 | POLICY | D：跨 Avatar 不产出关系（不误配） | PASS | [] |
| P-10 | POLICY | 同 Avatar 同名变体 → optional_variant/probable | PASS | [{"from":"v2","to":"v3","type":"optional_variant","confidence":"probable","evidence":"同模型 avatar#1 的同名变体：Manuka_v2 / Manuka_v3"}] |
| B-1a | PLAN | D 分析出 3 个可导入单元（model/material/texture） | PASS | D_companion.zip:multi_package_container \| MANUKA_material.unitypackage:single_unitypackage \| MANUKA_model.unitypackage:single_unitypackage \| MANUKA_texture.unitypackage:single_unitypackage |
| B-1b | PLAN | includeSuggested=false：计划只含 2 个选中单元、不含 suggested | PASS | ["MANUKA_material.unitypackage:pending","MANUKA_model.unitypackage:pending"] |
| B-1d | PLAN | 计划内容 = 恰好 2 个选中单元，无无关单元 | PASS | planId=1 |
| B-1c | PLAN | includeSuggested=true（真实 analyze 关系）：加入伴生单元且标 suggested | PASS | items=["MANUKA_material.unitypackage:pending","MANUKA_model.unitypackage:pending","MANUKA_texture.unitypackage:suggested"] relations=3 |
| B-1e | PLAN | 正例对照：有关系时 includeSuggested 加入且仅标 suggested | PASS | ["MANUKA_texture.unitypackage:pending","MANUKA_material.unitypackage:suggested"] |
| B-2a | PLAN | B 单元 policy=mixed_unitypackage 且可导入 | PASS | mixed_unitypackage |
| B-2b | PLAN | mixed plan_item.path === 原始整包路径 | PASS | /tmp/av-structure-jNAisx/e2e/B_mixed.unitypackage |
| B-2c | PLAN | 计划阶段不产生暂存/筛选包（目录未新增文件） | PASS | dirs=B_mixed.unitypackage,D_companion.zip,UnityProject |
| B-2d | PLAN | mixed 计划需人工确认（不自动执行） | PASS | needs_confirmation |
| B-3a | PLAN | 单包计划建立（ready） | PASS | ready |
| B-3b | PLAN | 改文件后 precheck → FINGERPRINT_CHANGED 且计划 blocked | PASS | code=FINGERPRINT_CHANGED |
| B-3c | PLAN | execute 同样被拦截（不执行外部导入） | PASS | code=PLAN_BLOCKED |
| B-4a | PLAN | Unity 不可用 → execute 被拦截（UNITY_UNAVAILABLE） | PASS | code=UNITY_UNAVAILABLE |
| B-4b | PLAN | 执行前后源文件 sha256 不变 | PASS | 52af6879c9fcb0fc -> 52af6879c9fcb0fc |
| B-4c | PLAN | 前置失败落 failed run（summary.phase=preflight） | PASS | run={"id":1,"status":"failed","phase":"preflight"} |
| B-4d | PLAN | 每个 plan_item 一条 failed run_item（可审计） | PASS | runItems=["failed"] |
| B-4e | PLAN | plan.lastError.code=UNITY_UNAVAILABLE（phase 见 run.summary） | PASS | {"code":"UNITY_UNAVAILABLE","message":"Unity 编辑器不可用或未返回工程路径"} summaryPhase=preflight |
| E5-2a | E | depth=3 嵌套 → 服务展开出可导入单元（rel_path 含 ::） | PASS | layer1/middle.zip::inner.zip::deep/inner.unitypackage:single_unitypackage:ok:imp=1 |
| E5-2b | E | depth=3 单元可建计划（单条） | PASS | planItems=1 |
| E5-2c | E | depth=4 超过上限 → limited 单元、无可导入单元 | PASS | (container):unknown_structure:ok:imp=0 \| L1/a.zip::L2/b.zip::L3/c.zip::L4/deep.zip:unknown_structure:limited:imp=0 |
| E5-2d | E | 超限单元建计划 → INVALID_INPUT（不伪造可执行计划） | PASS | code=INVALID_INPUT |

## SKIP 说明

- POLICY 组依赖 `packages/core/src/structure.ts`（task-37）。落地后重跑本脚本即自动启用；不伪造通过。
- PLAN 组依赖 task-38（结构服务/计划/预检 API）；后端就绪后补 e2e，本脚本已预留 ID（B-1..B-4）。
- `--strict` 会把 SKIP 视为失败，供 e2e 阶段使用。
