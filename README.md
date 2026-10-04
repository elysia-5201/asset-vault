# AssetVault · 资源库

BOOTH / Unity 素材整合管理软件：把散落在各下载目录里的素材收成**可检索的本地资源库**——
每条素材记录**来源网站/商品**、**多张缩略图**、**关联的压缩包与 unitypackage**、**适配哪些 avatar**，
并回答"这个素材对应哪个模型 / 我导入过没 / 上游更新了没"。

本地优先：无云、无账号、不搬动/不删除你的原始文件（默认**就地索引**）。

## 快速开始

```bash
cd <repo>
npm install                       # 依赖（含 better-sqlite3 / sharp 原生模块）
npx vite build --config apps/web/vite.config.ts   # 构建前端（产出 apps/web/dist）
node --import tsx apps/server/src/main.ts         # 起服务，默认 127.0.0.1:7317
```

浏览器打开 <http://127.0.0.1:7317>（Windows 侧同一 localhost 即可访问）。

后台运行（推荐）：

```bash
cd <repo>
nohup node --import tsx apps/server/src/main.ts > logs/server.out 2>&1 &
```

环境变量：`PORT`（默认 7317）、`HOST`（默认 127.0.0.1）、`ASSETVAULT_DATA`（数据目录，默认 `./data`）、
`ASSETVAULT_VERBOSE=1`（同时打到 stdout）。日志固定写 `logs/server.log`。

> 跑会写库的测试/验收请用独立数据目录，别污染日常库：
> `ASSETVAULT_DATA=$PWD/data-test PORT=7319 node --import tsx apps/server/src/main.ts`

## 现在能做什么（已验收）

| 能力 | 说明 |
|---|---|
| 扫库建档 | 扫目录 → 从文件名/文件夹名抽 BOOTH 商品号 → 回查商品页补全标题/作者/分类/标签/图集；无商品号的进 `inbox` 待人工确认（**宁缺勿错**） |
| 粘贴链接建档 | 支持 `booth.pm/{lang}/items/<id>`、`<shop>.booth.pm/items/<id>`、裸 ID；含 peek 只读预览 |
| 多缩略图 | BOOTH 官方图集 + 包内 `preview.png` + 压缩包内图片帧 + 用户自加图，统一转 webp 缩略图 |
| 压缩包内浏览 | zip/7z/rar **不解压**列目录、直读单条目预览（zip 直读支持 store/deflate；7z/rar 走 7zip-bin / node-unrar-js） |
| unitypackage 解析 | **不启动 Unity**：gzip+tar 读 `pathname` → 资产路径树 + 类型统计（实测 MANUKA 165 GUID：AnimationClip 78 / Texture2D 34 / Material 10 / Prefab 2 …） |
| avatar 维度 | 一条素材可适配多个模型；6 类证据（标题/BOOTH 标签/描述/包内路径/unitypackage 路径/文件名）自动打分，别名单表归一 |
| 按 avatar 快筛 | 头像轨点选即过滤，多选支持 **ANY / ALL**；`@Manuka 裙子` 语法；只看已拥有 |
| 中日文子串搜索 | SQLite FTS5 **trigram**（`Shinano` / `ミルフィ` / `しなの` / `milky` 均可中段命中；<3 字符回退 LIKE） |
| 更新检测 | 快照 `variations[].downloadable` 文件名/大小 + 价格 + 图集，一键"检查更新"出差异 |
| 作业与恢复 | 13 状态状态机 + CAS 转移；`kill -9` 后重启自动回收在飞作业（`recovered` 事件可查） |
| 回收站 | 软删可恢复；磁盘文件缺失只标 `missing`，记录与收藏不丢 |
| 收件箱监听 | 把 IDM/浏览器下载目录设为收件箱，新落盘的 zip/7z/rar/unitypackage **自动建档入库**（chokidar 轮询 + awaitWriteFinish，3 秒静默后触发） |

## 架构

```
asset-vault/
├─ packages/core/src/        # 纯逻辑层（可单测，无服务依赖）
│   ├─ contracts.ts          # 🔒 共享类型 + 状态机转移表 + normKey（冻结；改它要同步改测试与模型）
│   ├─ identify.ts           # 商品号抽取 / URL 解析 / 置信度
│   ├─ pathnorm.ts           # 路径归一（小写 + 正斜杠 + NFC）
│   ├─ source/booth.ts       # BOOTH 抓取（限速、退避、代理、登录页魔数识别）
│   ├─ avatars/{normalize,detect}.ts   # 别名归一 + 6 类证据打分
│   ├─ archive/{list,rar,zip-cd}.ts    # zip/7z/rar 列目录与直读
│   ├─ unitypackage.ts       # gzip+tar 解析
│   └─ images.ts / hash.ts   # sharp 缩略图 / 流式 sha256
├─ apps/server/src/          # Fastify + SQLite + 作业执行器
│   ├─ db/{schema.sql,migrate.ts,repo.ts,seed.ts}
│   ├─ jobs/runner.ts        # 状态机驱动 + worker
│   ├─ services/{booth,scan,indexing,match,updates,media}.ts
│   └─ http/routes.ts        # HTTP API（见 docs/api.md）
├─ apps/web/                 # React 19 + Vite（头像轨 / 网格 / 详情 / 包内树 / 作业面板 / 导入区）
├─ data/                     # vault.db + media/ 缩略图缓存（可重建）
├─ docs/{api.md,CONTRACT.md,verification/}
└─ scripts/{test.mjs,start.mjs,acceptance.sh,acceptance-ops.sh,ac06-crash.sh,seed-items.mjs,stop-server.mjs}
```

## 数据模型（SQLite，15 张核心表）

`items`（来源站+商品号唯一）· `item_images`（多图）· `assets`（压缩包，物理路径唯一）·
`archive_entries` · `unitypackage_assets` · `avatars` + `avatar_aliases`（别名唯一）+
`item_avatars`（多对多，含 manual/confirmed 保护）· `asset_avatars`（文件级 + 包内前缀）·
`tags`/`item_tags` · `collections` · `library_roots` · `projects`/`project_imports` · `jobs`/`job_events` ·
`source_snapshots`/`updates` · `settings`/`audit_log` + `items_fts`(FTS5 trigram)。

关键约束：`assets.path_norm` 唯一（不重复登记同一物理文件）；`jobs` 在飞作业对 (item_id, kind) **局部唯一**（单写入者，用 partial index 实现）；
`item_avatars` 主键 (item_id, avatar_id)；`asset_avatars` 唯一含 `IFNULL(entry_prefix,'')`；
不物理删除（`status` 软删）。



## 桌面版（Electron 便携版）— 当前推荐入口

| 项 | 值 |
|---|---|
| 可执行文件 | `%APP_DIR%\dist-desktop\win-unpacked\AssetVault.exe`（便携，免安装；整个 `win-unpacked` 文件夹可整体拷走） |
| 启动 | 双击 exe；窗口 + 内嵌服务一起起，浏览器也可开 <http://127.0.0.1:7317> |
| 数据 | 复用仓库的 `%APP_DIR%\data`（vault.db + media），与命令行版共用同一库 |
| 协议接管 | 已注册 `booth-library-manager://` → BOOTH 库存页点「DL with Booth Library Manager」即唤起本应用并自动下载入库 |
| 日志 | `dist-desktop\win-unpacked\logs\desktop.log`（主进程）、`logs\server.log`（服务） |
| 单实例 | 第二次点击/协议唤起只把 URL 转交给已运行实例，**不会再起第二个服务或打开第二份 DB** |

### 端口与下载目录
- 默认 7317；被占用时自动退到 7318/7319/7320/7321。
- 下载保存目录默认 `<数据目录>\downloads\b<商品号>\<原文件名>`，可改：
  ```bash
  curl -X PUT http://127.0.0.1:7317/api/settings -H 'content-type: application/json' -d '{"downloadRoot":"<drive>:\\game\\booth-downloads"}'
  ```

### 重建桌面版（改了源码之后）
```bash
# 在 Windows 侧 %APP_DIR% 下
node apps/desktop/build.mjs          # esbuild 打包 server（含 schema.sql）
npx electron-builder --win dir       # 产出 dist-desktop\win-unpacked
```
> 注意：npm 11 默认**不执行依赖的 install 脚本**，Electron 二进制需要手动补一次：
> `node node_modules/electron/install.js`（约 325 MB）。

### 打包时踩过的坑（都已修，留档）
1. **ESM 动态 import 不能传 Windows 绝对路径**：`import("<drive>:\\...")` 会报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，必须 `pathToFileURL(p).href`。
2. **CJS 依赖打进 ESM bundle 后仍 require('node:...')**：esbuild 输出 ESM 时加 banner `createRequire`。
3. **`import.meta.url` 相对路径在 bundle 里失效**：schema/seed/web dist 改为可显式传入（`startAssetVault({schemaFile, seedFile, webDistDir, logsDir})`）。
4. **asar 只读 + ESM 加载**：日志/DB 不能写进包内 → logsDir 指到 exe 同级；`app.getPath("exe")` 同级 `data` 优先，其次仓库根的 `data`。
5. **单实例锁必须放在起服务之前**：否则协议唤起的第二实例会先开一个服务/DB 再退出。
6. Electron 冷启动 20–50s 才 ready（本机实测），窗口晚于服务出现属正常。

## Windows 命令行部署（保留：调试/无 GUI 场景）

服务已经迁到 Windows 原生运行，**不再依赖 WSL**：

| 项 | 值 |
|---|---|
| 程序目录 | `%APP_DIR%` |
| 数据目录 | `%APP_DIR%\data`（`vault.db` + `media\` 缩略图） |
| 访问地址 | <http://127.0.0.1:7317>（Windows 浏览器；WSL 里同样可达，mirrored 网络） |
| 启动 | 双击 `%APP_DIR%\start-assetvault.cmd`（带控制台）或 `start-assetvault-hidden.vbs`（静默） |
| 停止 | 双击 `stop-assetvault.cmd`（按命令行精确匹配 node 进程） |
| 日志 | `%APP_DIR%\logs\server.log`、`logs\win-server.out` |
| Node | Windows 侧 Node v24.19.0；`better-sqlite3` 走自带 `prebuilds/win32-x64.node`，**不需要构建工具链** |

### 从 WSL 重新部署（改完 WSL 源码后同步过去）

```bash
# 1) 同步源码 + 数据（robocopy，排除 node_modules/logs）
%SystemRoot%/System32/cmd.exe /c "copy /y \\\\wsl.localhost\\<distro>\\<repo-in-wsl>\\scripts\\win-deploy.cmd %TEMP%\\ && %TEMP%\\win-deploy.cmd"
# 2) 若改了依赖
%SystemRoot%/System32/cmd.exe /c "cd /d %APP_DIR% && npm install --no-audit --no-fund"
# 3) 重启
%APP_DIR%\stop-assetvault.cmd && %APP_DIR%\start-assetvault.cmd
```

### 迁库时踩过的坑（脚本已固化，见 `scripts/win-*.mjs|cmd`）

- **路径语义要改写**：DB 里存的是 Linux 路径（`<win-drive>/...`、`<repo>/...`），Windows 上全部失效 →
  `scripts/win-migrate-paths.mjs` 做 `/mnt/<盘>/` → `<盘>:\`、仓库路径 → `%APP_DIR%\` 的改写，
  并同步 `path_norm`（`normalizePath` 同一实现，否则扫描时会被判成新文件）。
- **root 要指向真实目录**：`scripts/win-fix-roots.mjs` 收敛成一个真实根 `<drive>:\game\vrchatcache`。
- `/mnt/e` 等 Windows 盘在**本沙箱内是只读**的，所有 Windows 侧写入都通过
  `%SystemRoot%/System32/cmd.exe /c ...` 或 PowerShell 走 Windows 进程完成。

## 运行与验收

> 单测里有一批"真实样本"用例需要你自己的素材库；不设环境变量时它们会**自动 SKIP**（合成样本用例照常跑）：
> ```bash
> AV_SAMPLES_DIR=/path/to/your/library AV_DOWNLOADS_DIR=/path/to/downloads node scripts/test.mjs
> ```

```bash
node scripts/test.mjs                 # 全仓单测（184 用例 / 19 套件，含真实素材 fixture）
npx tsc --noEmit                      # 类型检查（0 error）
bash scripts/acceptance.sh            # AC1-AC12 冒烟（可加 B=http://127.0.0.1:7319、DB=<db路径> 触发 1000 条性能项）
bash scripts/acceptance-ops.sh        # AC7 缺文件标记 / D5 失败原因 / AC6 崩溃恢复
bash scripts/ac06-crash.sh            # AC6 真·kill -9（直接读 DB 取证，不受恢复后负载影响）

# 收件箱监听（下载目录自动入库）
curl -X POST localhost:7317/api/watch -H 'content-type: application/json' -d '{"path":"%DOWNLOADS%"}'
curl localhost:7317/api/watch
```

验收结论与原始证据见 `docs/verification/`；状态机与数据模型的可复现哈希见 `docs/verification/models/README.md`。

## 已知限制

- **RAR 直读**依赖 `node-unrar-js`（已装）；zip 里 LZMA/PPMd 条目可列目录但直读会抛可判别错误。
- **7z/rar 内嵌图片**不做缩略图抽取（zip 与 unitypackage 会抽）。
- 下载：MVP 只做"收件箱 + 粘贴链接建档"；带 cookie 直下 `downloadables`、以及接管
  `booth-library-manager://` 协议（免 cookie）留待 Windows 便携版（Electron）阶段。
- 扫大目录（如 `%LIBRARY%` 全量）第一次会很慢（要建缩略图 + 解析包），
  建议先 `POST /api/scan {dryRun:true}` 预览，再分批扫。
- BOOTH 无官方 API；用页面 JSON 接口 `/ja/items/<id>.json`，礼貌限速 0.7s，不绕 Cloudflare。