# 桌面发布入口（scripts/desktop-release.ps1）

一句话：**默认只出计划，不碰生产；要真发布必须显式 `-Execute` + 精确 `-ConfirmReleaseId`。**

## 1. 它是什么 / 不是什么

- 是：把 r11 已独立验收、已真实发布过的 13 个冻结脚本，加一个 stage 步骤，按固定顺序串起来的**唯一入口**。
- 不是：新的发布框架。它不重新实现 roots / freeze / old / new / marker / 收据校验——那些仍由 `scripts/desktop-release/runtime/` 里的原脚本执行；入口只负责顺序、独立进程、日志与停止规则。

## 2. 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `-ManifestPath` | 是 | 发布 manifest（`av-exec-manifest/v1`）。入口不内嵌 releaseId，全部从它读。 |
| `-PayloadSource` | 是 | 4 个构建产物的根目录；逐项 bytes+sha256 必须等于 `manifest.payload[].new`。 |
| `-LogDir` | 是 | 日志目录。**Plan 不创建它**；Execute 要求它**尚不存在**（已有目录一律拒绝，不覆盖旧证据），且不得与 AppRoot / AppPrivate / DataPrivate / data / stage / bak / 收据 / payload 源 / runtime / manifest 文件相交。 |
| `-Execute` | 否 | 不给 = Plan。 |
| `-ConfirmReleaseId` | Execute 必填 | 必须**逐字节**等于 `manifest.releaseId`（大小写敏感，`-cne`）。 |
| `-AppRoot` | Execute 必填 | 生产 app 根，必须与 `manifest.appRoot` 精确一致；**没有默认值**。Plan 可选：给了就做纯路径比对，不访问该目录。 |
| `-DataPrivate` | Execute 必填 | 生产 data private 根，必须与 `manifest.dataPrivate` 精确一致；**没有默认值**。Plan 可选。 |
| `-RuntimeDir` | 否 | 默认 `<入口目录>\desktop-release\runtime`。 |
| `-PowerShellPath` | 否 | 默认 `$PSHOME\powershell.exe`；只用于起子进程。 |

## 3. Plan（默认）

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\desktop-release.ps1 `
  -ManifestPath <manifest.json> -PayloadSource <构建产物根> -LogDir <日志目录>
```

- 只读：读 manifest、读 payload 源、读 runtime 字节；**不访问生产树、不写文件、不起子进程**。
- 输出一段 JSON：`mode=plan`、`manifest`（releaseId / stamp / roots / payload 引脚）、`runtime`（13 文件 + 聚合 + freeze/stage 哈希）、`payloadSource`（4 文件已核）、`paths`（由 `Resolve-ExecPaths` 推出的 stage / marker / archive / receipt / backup 路径）、`steps`（6 步及参数）、`rootsVerified`（给了 `-AppRoot`/`-DataPrivate` 且与 manifest 精确一致时为 true）。
- payload 数量必须恰好 4（与 `stage.ps1` 的 4 文件不变量一致）；数量不符时 Plan 直接失败，不会给出一个 Execute 必然在第一步失败的“有效”计划。
- 三个输入路径在输出里占位化为 `<manifest>` / `<payload-source>` / `<log-dir>`，避免把本机私有路径写进证据日志。
- 退出码：0 = 计划有效；非 0 = 校验失败（stderr 一行 `RELEASE: ...`）。

## 4. Execute

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\desktop-release.ps1 `
  -ManifestPath <manifest.json> -PayloadSource <构建产物根> -LogDir <全新日志目录> `
  -AppRoot <生产 app 根> -DataPrivate <生产 data private 根> `
  -Execute -ConfirmReleaseId <manifest.releaseId>
```

顺序固定：**stage → close → backup → archive → apply → start**（start 最多一次）。

- 每个入口都是独立的 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <entry> <args>` 顶层进程；stdout / stderr / exit 分别写 `<LogDir>\<step>.out.txt` / `.err.txt` / `.rc`。不使用 `&` 调用、不使用 `Invoke-Expression`。
- 命令行按 Windows argv 规则逐参数引用（空格、末尾反斜杠、引号附近反斜杠、空值、Unicode 都原样到达子进程）；`Start-Process -ArgumentList` 只接收这一条已构造好的命令行，不再依赖数组自动拼接。
- `-ExecutionPolicy Bypass` 只作用于该子进程；不改持久 scope（发布后 `Get-ExecutionPolicy -List` 仍应全 Undefined）。
- 任一步 rc≠0：**立即停止**。不重试、不打补丁、不回滚、不自动启动旧版；stderr 打印 `RELEASE: STOPPED at <step> rc=<n>`，入口以该 rc 退出。
- Execute 前置门（本入口把检查提前，不是 runtime 新增能力）：先做纯路径的 root 身份门（`-AppRoot`/`-DataPrivate` 与 manifest 精确一致，派生路径再核一次），再做 LogDir 全新/隔离门，最后才是 runtime 原有的 reparse + 同卷门（`AppRoot` / `AppPrivate` / `DataPrivate` / `data` 四处）。R1 的 AppPrivate 显式检查本来就在 `apply.ps1`，本入口只是把它提前到任何步骤之前。
- 写盘从第 6 步才开始：`<LogDir>\plan.json`（脱敏计划）、逐步日志、`<LogDir>\summary.json`。

## 5. 失败之后（没有自动恢复）

- close 之后任何一步失败：**不要**用 `start.ps1` 重启（旧 marker 的 post 是旧哈希，start 必拒）。保持停止，人工复核后再决定手工启动或恢复。
- apply 中途失败：marker 不存在、App 停止；保留 `bak\bak-<文件名>.<stamp>.<hex>`，逐项恢复旧字节（恢复后哈希必须等于 `manifest.payload[].old`），删除已创建的 new JS；回滚需第二人复核。
- archive 之后 apply 之前失败：marker 已移入 `APPLY-OK.previous-<stamp>-<releaseId>.json`；恢复 = 把该文件复制回 `APPLY-OK.json`（字节 SHA 必须仍等于 `manifest.legacyArchive.markerSha256`），再人工复核。
- 收据与备份位置：`<dataPrivate>\close-receipt-<stamp>-<releaseId>.json`、`<dataPrivate>\db-backup-<stamp>\`、`<dataPrivate>\db-backup-receipt-<stamp>-<releaseId>.json`、`<appPrivate>\bak\`。

## 6. 冻结来源

- 13 文件来自 `candidate/exec-r11`（r11 冻结包），逐项 sha256 / bytes 与 `runtime/freeze.json` 全等；聚合 `b07f072e843e015c934c8adaa37443be812297e2a5e502d566ae306549364782`（定义：按 name 序数排序，`<sha>  <name>` 用 `\n` 连接、无尾换行，再取 sha256）。
- `stage.ps1` 逐字节复制自 r11 真实发布执行者的 step 1 脚本（sha256 `f1486de950711090518fdd21013ab36a2ae583e8ae91142a6520060810b84227`），因为冻结包本身不含 stage 步骤；与生产执行者版本零差异，不是重写。
- 入口把 `freeze.json`（`d098c86c…`）与 `stage.ps1` 的哈希钉在 `release-core.ps1` 顶部；改冻结包必须同时改这两个常量。校验顺序：freeze.json 自身哈希 → 13 文件逐项 bytes+sha256 → 聚合 → stage.ps1 哈希；任何一项不符即停止，且不会 dot-source 未通过校验的 runtime 脚本。
- `stage.ps1` 断言 stage 根恰好 4 个 payload 文件（r11 形态，与生产执行者一致）；payload 数量变化需要重新验收 stage 步骤，不要直接改这个文件。

## 7. 验收范围（不要外推）

- 已独立验收并真实发布的是 r11 冻结包本身：见 [r11 证据摘要](release-evidence/r11-summary.md)（READY_FOR_PRODUCTION + PUBLISHED；四 payload SHA、独立测试结果、原始报告 SHA 与验证范围均在该摘要内）。原始详细取证（日志、result、截图、Windows TEMP）仍另存于仓库外归档，本文件不依赖该归档路径解析。
- 那次发布的 UI 验收是**合成写**：所有写操作落在本地合成数据上，真实上游非 GET 请求为 0；不是对真实 BOOTH / 上游的写验证。
- 本入口本轮只跑过 Plan 与离线 / TEMP 夹具；**没有**再执行一次真实生产发布。Execute 分支的现场首次执行门（真实 CloseMainWindow、真实 CIM / NetTCP、真实 marker 移动）仍按 r11 runbook 的 F7 处理。
