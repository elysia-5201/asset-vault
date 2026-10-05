# AssetVault · 资源库

> 把散落在各个下载目录里的 BOOTH / Unity /VRChat素材，收成一个**可检索、能直接导进 Unity** 的本地资源库。

每条素材会记下**来源商品**、**多张缩略图**、**关联的压缩包与 unitypackage**、**适配哪些 avatar**，
并回答三个每天都在问的问题：**这个素材是给哪个模型的 / 我导入过没 / 上游更新了没**。

本地优先：无云、无账号、默认**就地索引**，不搬动也不删除你的原始文件。

`Node 22+` · `Windows 便携版（Electron）` · `SQLite 单文件` · `无需任何外部服务`

---

## ✨ 特性

| 能力 | 说明 |
|---|---|
| **扫库建档** | 扫目录 → 从文件名/文件夹名抽 BOOTH 商品号 → 回查商品页补全标题/作者/分类/标签/图集；没商品号的进 `inbox` 待人工确认（**宁缺勿错**） |
| **粘贴链接建档** | 支持 `booth.pm/{lang}/items/<id>`、`<shop>.booth.pm/items/<id>`、裸 ID；带 peek 只读预览 |
| **多缩略图** | BOOTH 官方图集 + 包内 `preview.png` + 压缩包内图片帧 + 用户自加图，统一转 webp 缩略图（卡片永远有图，不用 hover） |
| **压缩包内浏览** | zip/7z/rar **不解压**列目录、直读单条目预览；**内层压缩包可点开**（`▸ 📦` 展开一层），不再只看到一行 `xxx.zip` |
| **unitypackage 解析** | **不启动 Unity**：gzip+tar 读 `pathname` → 资产路径树 + 类型统计；压缩包**里面**的 .unitypackage 同样解析（实测 463MB 的包 328 项、MANUKA 165 GUID） |
| **包内文件预览** | `Assets/…/ReadMe.txt` / `.mat` / `.asset` / `.prefab` / `.anim` 点一下就能看（Unity 这些本来就是 YAML 文本）；图片走图片预览，真二进制会明确说不预览 |
| **avatar 维度** | 一条素材可适配多个模型；6 类证据（标题 / BOOTH 标签 / 描述 / 包内路径 / unitypackage 路径 / 文件名）自动打分，别名单表归一 |
| **自动校准** | 只要**包内容**里认出了某些模型，就按内容口径算适配；只在商品页标签里出现过的不算（商品页声明另存为「声明适配」）。**通用工具类素材**（插件/姿势/着色器）不吃这套 |
| **按 avatar 快筛** | 头像轨点选即过滤，多选支持 **ANY / ALL**；`@Manuka 裙子` 语法；只看已拥有 |
| **中日文子串搜索** | SQLite FTS5 **trigram**（`Shinano` / `ミルフィ` / `しなの` / `milky` 都能中段命中；<3 字符回退 LIKE） |
| **更新检测** | 快照 `variations[].downloadable` 文件名/大小 + 价格 + 图集，一键「检查更新」出差异 |
| **作业与恢复** | 13 状态状态机 + CAS 转移；`kill -9` 后重启自动回收在飞作业（`recovered` 事件可查） |
| **回收站** | 软删可恢复；磁盘文件缺失只标 `missing`，记录与收藏不丢 |
| **收件箱监听** | 把 IDM / 浏览器下载目录设为收件箱，新落盘的 zip/7z/rar/unitypackage **自动建档入库**（chokidar + awaitWriteFinish，3 秒静默触发） |
| **真导入 Unity** | 详情页「导入到 Unity 工程」：探测**当前打开的那个编辑器**（mcp-for-unity），列出条目里所有 `.unitypackage`（压缩包内的、zip 套 zip 的也算）→ 按当前工程的 avatar **自动预选** → `AssetDatabase.ImportPackage(path,false)` 真导入；导入前清控制台、导入后回读报错 |
| **套装 / 合并** | 同一商品拆成「模型包 + 材质包/DLC」时，用**套装**归组（各自保留条目），确认后再**合并**成一条（压缩包/图片/标签全并过去，来源进回收站可恢复）；套装里有一键「⤵并入」 |
| **来源可点 + 一键补全** | 「来源」行里 `BOOTH 7562436` 是直达商品页的超链接，旁边的「补全 BOOTH」直接重抓标题/店铺/价格/标签 + 图集 |

---

## 🎨 预览

界面是三段式：**左侧头像轨 / 中间卡片网格 / 右侧详情抽屉**；详情里依次是缩略图管理、包内目录与 unitypackage 资产、适配模型与证据、导入 Unity、作业面板。

> 本仓库**暂未提交截图**：作者的素材库以 R18 内容为主，直接截图放进公开仓库不合适。
> 想先看一眼：按下面「快速开始」跑起来即可；或者翻 `docs/verification/`（验收证据，含接口/状态机的原始输出与可复现哈希）。

---

## 🚀 快速开始

### 命令行版（Windows / WSL / Linux / macOS）

```bash
git clone https://github.com/elysia-5201/asset-vault.git
cd asset-vault
npm install                                      # 含 better-sqlite3 / sharp 原生模块
npx vite build --config apps/web/vite.config.ts  # 构建前端（产出 apps/web/dist）
node --import tsx apps/server/src/main.ts        # 起服务，默认 http://127.0.0.1:7317
```

或者直接 `npm start`（缺前端产物时会自动构建）。

### 桌面便携版（Windows，推荐）

```bash
npm install
node node_modules/electron/install.js   # npm 11 不跑依赖的 install 脚本，Electron 二进制要手动补一次（约 325MB）
npm run desktop:bundle                  # esbuild 打包服务端 + schema
npm run desktop:dist                    # electron-builder → dist-desktop/win-unpacked/AssetVault.exe
```

双击 `AssetVault.exe`：窗口 + 内嵌服务一起起来，免安装，整个 `win-unpacked` 文件夹可以直接拷走。

### 测试与验收

```bash
node scripts/test.mjs            # 全仓单测（195 用例 / 19 套件；真实素材 fixture 需环境变量，未设则 SKIP）
npx tsc --noEmit                 # 类型检查（0 error）
bash scripts/acceptance.sh       # AC1-AC12 冒烟
bash scripts/acceptance-ops.sh   # 缺文件标记 / 失败原因 / 崩溃恢复
bash scripts/ac06-crash.sh       # AC6 真·kill -9（直接读 DB 取证）
```

> 跑会写库的测试请用独立数据目录，别污染日常库：`ASSETVAULT_DATA=$PWD/data-test PORT=7319 node --import tsx apps/server/src/main.ts`

---

## 📖 使用说明

### 1. 把素材收进来

- **扫库**：设置里加一个「库根」（默认**就地索引**），或先 `POST /api/scan` 带 `{"dryRun":true}` 预览再分批扫。
- **粘贴链接**：知道商品链接时直接贴，比扫库更准。
- **收件箱监听**：把 IDM / 浏览器下载目录设为收件箱，下载完自动建档。
- **协议接管（桌面版）**：已注册 `booth-library-manager://`，BOOTH 库存页点「DL with Booth Library Manager」即唤起应用并自动下载入库。

### 2. 找素材

- 头像轨点模型名 → 只看适配它的素材；多选时用 **ANY / ALL** 切换口径；勾「只看已拥有」过滤掉没买的 base。
- 搜索框支持中日文子串，也支持 ` @Manuka 裙子 ` 这种把头像名写进查询的语法。
- 卡片角标：`在库 / 待整理 / 已导入 / 收藏`；绿标是套装名。

### 3. 校正「适配模型」

卖家常把「本商品支持的全部 base」都打成 tag，所以一条只有 Shinano 变体的素材可能被标上 7 个模型。
现在**默认按包内内容校准**；如果仍看到只有商品页证据的模型，详情页右上会出现「按包内证据校正（去 N 个）」一键清理
——**通用工具类素材（全アバター対応）别点**。

### 4. 导入 Unity（真导入，不是登记）

1. 目标工程里装好 `com.coplaydev.unity-mcp`，并**打开该工程**；
2. 详情页「导入到 Unity 工程」→「重新检测」应显示 `已连接 · <工程名> · Unity <版本>`；
3. 勾选要导入的 `.unitypackage`（默认只预选当前工程那个 avatar 的包）→「导入到 <工程名>」；
4. 导入前会清空 Unity 控制台，导入后回读 error，结果直接显示在下面。

> 也支持只「标记已导入」写本地记录（不动 Unity），两件事在界面上是分开的。

### 5. 套装与合并

- **套装**：同一商品拆卖的「模型包 + 材质包 / DLC」，先归组，条目各自保留；
- **合并**：确认后把来源条目并进目标（压缩包 / 图片 / 标签 / 模型关联 / 更新历史全过去，来源进回收站可恢复）；
- **删除整个套装**：徽章旁的 🗑 只删分组，不动条目。

### 6. HTTP API

完整契约见 `docs/api.md`（含 Unity 桥、套装、合并、导入等端点）；健康检查 `GET /api/health`。

---

## 🛠️ 技术栈

| 层 | 用了什么 |
|---|---|
| 运行时 | Node 22+ / TypeScript 5（ESM，`tsx` 直跑 TS） |
| 服务端 | Fastify 5 + 自研 13 状态作业机（CAS 转移 + 崩溃恢复） |
| 数据库 | better-sqlite3（WAL + FTS5 **trigram** + partial index 保证单写入者） |
| 前端 | React 19 + Vite 8，手写 CSS（无 UI 框架） |
| 桌面 | Electron 38 + electron-builder（便携 `--win dir`，`asar:false`） |
| 归档 / 媒体 | node-stream-zip（zip 直读）· 7zip-bin（7z）· node-unrar-js（rar）· sharp（缩略图）· undici（BOOTH 抓取） |
| 质检 | `node:test` 195 用例 + `tsc --noEmit` + 验收脚本（AC1–AC12） |

### 打包与迁移踩坑（留档）

1. **ESM 动态 import 不能传 Windows 绝对路径** → 必须 `pathToFileURL(p).href`，否则 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
2. **CJS 依赖打进 ESM bundle 后仍 `require('node:…')`** → esbuild 输出加 `createRequire` banner。
3. **`import.meta.url` 相对路径在 bundle 里失效** → schema / seed / web dist / logs 全部可显式传入。
4. **asar 只读** → 日志与 DB 写到 exe 同级的 `data/`、`logs/`；单实例锁必须放在起服务**之前**。
5. **迁移时路径语义要改写**（Linux 路径 → Windows），且 `path_norm` 要用同一实现重算，否则会被判成新文件。
6. npm 11 默认不执行依赖的 install 脚本 → Electron 二进制手动 `node node_modules/electron/install.js`。

---

## 📁 项目结构

```
asset-vault/
├─ packages/core/src/        # 纯逻辑层（可单测、无服务依赖）
│   ├─ contracts.ts          # 🔒 共享类型 + 状态机转移表 + normKey（改动需同步测试与模型）
│   ├─ identify.ts           # 商品号抽取 / URL 解析 / 置信度
│   ├─ source/booth.ts       # BOOTH 抓取（限速、退避、代理、登录页识别）
│   ├─ avatars/              # 别名归一 + 6 类证据打分
│   ├─ archive/              # zip / 7z / rar 列目录与直读
│   ├─ unitypackage.ts       # gzip+tar 解析与条目读取
│   └─ images.ts / hash.ts   # sharp 缩略图 / 流式 sha256
├─ apps/server/src/          # Fastify + SQLite + 作业执行器
│   ├─ db/                   # schema.sql / migrate / repo / seed
│   ├─ jobs/runner.ts        # 状态机驱动 + worker
│   ├─ services/             # booth / scan / indexing / match / updates / media / download / unity
│   └─ http/routes.ts        # HTTP API（契约见 docs/api.md）
├─ apps/web/                 # React 19 + Vite（头像轨 / 网格 / 详情 / 包内树 / 作业 / 导入）
├─ apps/desktop/             # Electron 主进程 + esbuild 打包脚本
├─ config/avatars.seed.json  # 头像与别名种子（可编辑，首次启动播种）
├─ data/                     # vault.db + media/ 缩略图缓存（可重建）
├─ docs/                     # api.md / CONTRACT.md / verification/
└─ scripts/                  # test / start / acceptance / win-* / sanitize 等
```

**数据模型**（SQLite，15 张核心表）：`items`（来源站+商品号唯一）· `item_images` · `assets`（物理路径唯一）·
`archive_entries` · `unitypackage_assets` · `avatars` + `avatar_aliases` + `item_avatars`（多对多，含 manual/confirmed 保护）·
`asset_avatars`（文件级 + 包内前缀）· `tags` / `item_tags` · `collections` · `library_roots` · `projects` / `project_imports` ·
`jobs` / `job_events` · `source_snapshots` / `updates` · `settings` / `audit_log` + `items_fts`（FTS5 trigram）。
不物理删除（`status` 软删）。

---

## ⚙️ 配置

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `7317` | 服务端口（桌面版被占用时自动退到 7318–7321） |
| `HOST` | `127.0.0.1` | 只监听回环 |
| `ASSETVAULT_DATA` | `./data` | 数据目录（`vault.db` + `media/` + `unity-staging/`） |
| `ASSETVAULT_VERBOSE` | — | 置 1 时日志同时打到 stdout |
| `AV_SAMPLES_DIR` / `AV_DOWNLOADS_DIR` | — | 真实素材 fixture（不设则相关单测 SKIP） |

### 运行时可改（`PUT /api/settings`）

```bash
# 下载保存目录（默认 <数据目录>/downloads/b<商品号>/）
curl -X PUT http://127.0.0.1:7317/api/settings -H 'content-type: application/json' \
     -d '{"downloadRoot":"E:/game/booth-downloads"}'

# Unity MCP 端点（默认自动探测 127.0.0.1:8080/mcp → 14523/mcp）
curl -X PUT http://127.0.0.1:7317/api/settings -H 'content-type: application/json' \
     -d '{"unityMcpUrl":"http://127.0.0.1:8080/mcp"}'
```

- **库根**：`GET/POST /api/roots`，默认 `index_in_place`（不改动你的文件）。
- **头像表**：`config/avatars.seed.json`（名字 + 别名）；首次启动播种，之后可在界面里增删别名。
- **日志**：命令行版 `logs/server.log`；桌面版 `dist-desktop/win-unpacked/logs/desktop.log`。

---

## 📋 TODO

- [ ] 选个 LICENSE（建议 MIT）并补 `LICENSE` 文件
- [ ] 用**脱敏样库**做几张截图 / GIF，把上面「预览」补上
- [ ] 7z / rar 内嵌图片也抽缩略图（现在只抽 zip / unitypackage）
- [ ] 「全アバター対応」工具类素材的匹配口径做成开关（现在是内容证据优先）
- [ ] 头像别名继续补（Chiffon / Milltina 已补；mao / koyuki / rurika 这类还没有）
- [ ] `data/unity-staging/` 自动清理（导入与预览的落地包会累积）
- [ ] macOS / Linux 桌面版（现在只打 Windows 便携包）
- [ ] CI 覆盖三平台单测（现在 workflow 只在 `windows-latest` 跑）
- [ ] 「全库批量重跑匹配 + 校准」的 UI 入口（现在得调 API）
- [ ] 超大包（>500MB）解析进度反馈

---

## 🐛 Bug / 已知问题

- **RAR**：直读依赖 `node-unrar-js`；zip 里 LZMA/PPMd 条目能列目录但直读会抛可判别错误（不是崩溃）。
- **7z / rar 内嵌图**：不做缩略图抽取。
- **首次全量扫大目录很慢**（要建缩略图 + 解析包）：先 `POST /api/scan` 带 `{"dryRun":true}` 预览，再分批扫。
- **BOOTH 无官方 API**：走商品页 JSON（`/ja/items/<id>.json`），礼貌限速 0.7s，不绕 Cloudflare；页面结构变了就要跟着改解析。
- **导入 Unity 的前置条件**：工程装了 `com.coplaydev.unity-mcp` 且编辑器开着；MCP 不在时会明确显示「没连上 + 探测了哪些端口」，不会静默失败。
- **只有 `.unitypackage` 能自动导入**：纯贴图 / PSD 素材不会出现在导入列表里。
- **商品页标签口径**：卖家常把「支持的全部 base」打成一堆 tag。默认**内容证据优先**（商品页声明另存「声明适配」）；通用工具类素材不受影响。
- **头像表是白名单**：不在表里的模型不会被匹配（显示为 `?`），需要手动补名字/别名。
- **`data/unity-staging/` 会累积**：可以随时整个删掉（只是缓存）。

---

## 🤝 贡献

1. Fork + 开分支（`feat/xxx` / `fix/xxx`）；
2. 改完必须过：`npx tsc --noEmit` + `node scripts/test.mjs`（0 fail）；
3. `packages/core/src/contracts.ts` 是**冻结契约**（共享类型 / 状态机转移表 / `normKey`）——要改就先说明为什么，并同步测试与模型；
4. HTTP 契约改动同步更新 `docs/api.md`；
5. 新能力请带上一条可复现的验收路径（脚本或 API 调用序列），PR 描述里贴原始输出。

Issue 里请附：操作系统 / Node 版本 / 复现步骤 / `logs/server.log` 相关片段（**注意给素材路径打码**）。

---

## 📄 License

本仓库**当前没有 LICENSE 文件**（默认保留所有权利）。如果你想拿去做二次开发，
说一声我加上 **MIT**；有别的偏好（Apache-2.0 / GPL-3.0）也可以。

---

## ⭐ Star

如果这个东西帮你把几百个素材从「文件夹地狱」里捞了出来，**点个 Star** 就是最实在的支持 ⭐

<https://github.com/elysia-5201/asset-vault>
