# r11 发布证据摘要（仓库内稳定引用）

本文件是 `docs/desktop-release.md` §7 的稳定引用，只汇总已由独立报告支持的事实。原始详细取证（逐步日志、`result.json`、截图、Windows TEMP）仍保存在仓库外归档，不随仓库分发；本文件不复制私有 result、截图或本机用户路径。归档目录移动不影响本文件解析。

## 1. 发布身份

| 项 | 值 |
|---|---|
| 冻结包 | r11（13 个 runtime 文件 + `stage.ps1`） |
| releaseId / stamp | `81a95580` / `20261103-175541` |
| manifest SHA256 | `0f19d7eed199c32c7095117ce9404078f4dc3e01c65461fc227950ac6dec23bd` |
| 13 文件聚合 SHA256 | `b07f072e843e015c934c8adaa37443be812297e2a5e502d566ae306549364782` |
| `freeze.json` SHA256 | `d098c86c744e645ccd3a95664a22abb4c3fe36b7646c9ddd6a09342795a6c42b` |
| `stage.ps1` SHA256 | `f1486de950711090518fdd21013ab36a2ae583e8ae91142a6520060810b84227` |

聚合定义：按 name 序数排序，`<sha>  <name>` 用 `\n` 连接、无尾换行，再取 sha256。

## 2. 四个 payload（发布后字节）

| rel | bytes | sha256（new） |
|---|---|---|
| `apps/desktop/build/server.mjs` | 2,491,680 | `c8bab41bd57fc1c9020bbaa5123653ae3f74ceecd1cf16cfff8d20fee3cd69c2` |
| `apps/desktop/build/build-info.json` | 208 | `c7b9e3dc00ee1b8128c91a1cfa1e5321e84070d2613538236bac2a1379d5463a` |
| `apps/web/dist/index.html` | 406 | `816e076f61b573d13160ed964882bc29555486d645a393f037a1c6afcfeffdd5` |
| `apps/web/dist/assets/index-y4B2X0-G.js` | 539,375 | `a6bf038224c7303f6a60db773e66564769f010e9921bbd44185cf1ab44b65ee4` |

发布前旧值：server `7d0fb96279274971e8b286cc83f688a0b28ff0deee51bd9e900d5ff98bb0ef4b` / 2,481,482；build-info `588e9040ff0e32cc4a0545c98f8b27a41ab8eca83ff6cdb041438ba40c94861a` / 208；index `09d4f8c3f574761339de5b8f6b48e5a6911d40b082df718251d1698263d47d2c` / 406；新 JS 不存在。旧 JS `e8b8ca9692899fb8721b1564c1dcb4199146deffa5f03d2e8a7a236d103d5857` / 533,727、schema `2333f6e83e6410bc80109bf67b7eea1cec181fb260f2fdb03b58978a6466ae51` / 24,171、css `63cac50107ed636867c4007b806cff40e52c63d7d177cb630266d7ef09b55201` / 28,860 发布后字节不变。

## 3. 独立验收与发布结果

### 3.1 r11 独立验收 — READY_FOR_PRODUCTION

- 报告：`review/exec-r11-final/review-sanitized.md`，SHA256 `16e3656cba621307f9783d6fd2ad342aca8ae8ecd7d433404cd204e706f71fb1`，独立验收者（非实现者），2026-11-04 02:03–02:20 +08:00。
- 判定与依据：报告 `:13`、`:15`；最终冻结包独立重跑 controls 187/187、AST 123/123、behavior 118/118、fixture 18/18、shadow 49/49；r10 对照 8/49 红（有辨别力，`:161`、`:165`）。
- 生产只读基线全绿、零生产写：`:211`、`:409`。

### 3.2 真实生产发布 — PUBLISHED

- 报告：`production/exec-r11/publish-sanitized.md`，SHA256 `dff340b96dd14961a6dd09fcfaa0af531c6f40adca7ae931fa977d5b8ef45d4e`，唯一生产发布执行者，2026-11-04 02:18–02:24 +08:00。
- 判定：`:13`、`:185`；8 步（stage → close → backup → archive → apply → 一次 start → 运行字节核验）全部 exit 0，无重跑、无补丁、无回滚、无强杀、无第二次 start（`:15`、`:48-59`）。
- payload 源与哈希：`:30-35`；前后对照：`:121-130`。

### 3.3 UI 四场景 — PASS（合成写）

- 报告：`postdeploy/ui-phase-r11-final/review-sanitized.md`，SHA256 `1934518067ab81b88fa6a8ad833e5f4e2627c53e712dbe844a7ccf7315e69a3e`，独立复核者（非作者、非发布者），2026-11-04 03:34–03:40 +08:00。
- 仪器修复 PASS：diff 2 hunks / +2 −1；离线 GREEN 6/6、RED 4/2、早赋值 mutant T2/T3 FAIL（`:15`、`:70-72`、`:239`）。
- 四场景 UI 单次实跑 PASS：rc=0，S1–S4 全部原断言走完，`result.json` 落盘（`:16`、`:108-113`、`:240`）。
- 网络封闭 PASS：proxy 173 条，non-GET allow=0、业务 POST allow=0、上游 non-GET=0（`:17`、`:138-153`、`:241`）。
- 图片不呈现：截图 private、mask 已知不足、未 OCR、未上传；与 UI PASS 分开判定（`:18`、`:173-176`、`:242`）。

### 3.4 发布入口离线验收 — PASS_OFFLINE

- 报告：`finalization/entry-guards-review/review-sanitized.md`，SHA256 `1d9a230305825ed8f29e895183d52d87ad99c93e008d3e2b95dd89e2da216c08`，独立最终复核者（非作者），2026-11-04 04:29–04:40 +08:00。
- 判定：`:14`；3P2 闭环（root 身份门 / LogDir 全新隔离门 / Windows argv 引号）均有“新代码拒绝、旧代码放行”的正反对照。
- 复跑：定向 15/15、原 sequence 8/8、新 guards 27/27、语法 5/5、`tsc --noEmit` rc=0（`:19`、`:155-160`）。
- 边界：**新入口从未真实 Execute**；本判定只覆盖离线验收（`:20`、`:233`）。

## 4. 验证范围（不要外推）

- UI 验收是合成写：所有写操作落在本地合成数据上，真实上游非 GET 请求为 0；不是对真实 BOOTH / 上游的写验证（`docs/desktop-release.md:72`；UI 报告 `:17`、`:159`）。
- 新发布入口只跑过 Plan 与离线 / TEMP 夹具，没有再执行一次真实生产发布；Execute 分支的现场首次执行门（真实 CloseMainWindow、真实 CIM / NetTCP、真实 marker 移动）仍按 r11 runbook 的 F7 处理（`docs/desktop-release.md:73`；guards 报告 `:20`、`:233`）。
- 截图/图片为 private，不展示、不 OCR、不上传；不构成产品 HOLD（UI 报告 `:18`、`:176`）。
- 本摘要不重跑 15/8/27/4UI/967 等测试，只引用上述报告已记录的结果。

## 5. 原始报告身份与 SHA

| 角色 | 归档内相对路径 | SHA256 | 关键行 |
|---|---|---|---|
| r11 独立验收（非实现者） | `.asset-vault-polish-release-20261103-2059/review/exec-r11-final/review-sanitized.md` | `16e3656cba621307f9783d6fd2ad342aca8ae8ecd7d433404cd204e706f71fb1` | `:13`、`:15`、`:161`、`:211`、`:403-409` |
| 唯一生产发布执行者 | `.asset-vault-polish-release-20261103-2059/production/exec-r11/publish-sanitized.md` | `dff340b96dd14961a6dd09fcfaa0af531c6f40adca7ae931fa977d5b8ef45d4e` | `:13`、`:30-35`、`:48-59`、`:121-130`、`:185` |
| UI 四场景独立复核 | `.asset-vault-polish-release-20261103-2059/postdeploy/ui-phase-r11-final/review-sanitized.md` | `1934518067ab81b88fa6a8ad833e5f4e2627c53e712dbe844a7ccf7315e69a3e` | `:15-18`、`:70-76`、`:108-113`、`:138-153`、`:173-176` |
| 发布入口离线最终复核 | `.asset-vault-polish-release-20261103-2059/finalization/entry-guards-review/review-sanitized.md` | `1d9a230305825ed8f29e895183d52d87ad99c93e008d3e2b95dd89e2da216c08` | `:14-20`、`:145-146`、`:155-160`、`:230-233` |

归档目录位于仓库外，保留不删不改；上表路径仅用于身份追溯，不是本仓库内的可点击链接。原始逐步日志、`result.json`、截图与 Windows TEMP 均未随仓库保存。

## 6. 维护规则

- 本摘要中的 SHA 与行号来自 2026-11-04 的实时读取与 `sha256sum` 复算；原始报告若被改动，本摘要必须同步复核。
- 更新 `docs/desktop-release.md` §7 时，只改本仓库内链接；不要把仓库外归档路径写成主文档依赖。
- 本摘要不替代原始报告，也不构成新的验收结论。
