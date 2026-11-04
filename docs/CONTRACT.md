# AssetVault 团队契约（FROZEN）

## 0. 现状
仓根 `<repo>`（**Git 仓库**，当前 HEAD 以 `git rev-parse HEAD` 为准）。已由 lead 冻结：
- `packages/core/src/contracts.ts` —— 所有共享类型 + 状态机转移表（**只读，禁止改；要改先找 lead**）
- `apps/server/src/db/schema.sql` + `migrate.ts` —— 15 表 + FTS5(trigram)
- `docs/api.md` —— HTTP API v1（冻结）
- `package.json` / `tsconfig.json` / `scripts/test.mjs`（测试入口）

Git 纪律：**不 commit、不 push、不 reset 用户状态**；改任何文件前先 `git status` 确认没有别人的未提交改动，有则保留并基于当前内容编辑。

## 0.1 产品目标与数据流（一屏导览）

**目标**：把散落在下载目录里的 BOOTH / Unity / VRChat 素材，收成一个可检索、适配关系可解释、能按需导入 Unity 的本地索引库；索引过程不搬动、不删除源文件。

```
文件系统
  → 扫描登记        registerAssets(../apps/server/src/services/scan.ts:396)
  → 限额分阶段索引  indexAsset(../apps/server/src/services/indexing.ts:38) + limits(../apps/server/src/services/pipeline/limits.ts:11)
  → 内容证据匹配    matchItem(../apps/server/src/services/match.ts:20)
  → 本地查询 / API  routes(../apps/server/src/http/routes.ts)
  → 可选 Unity 导入（显式操作，不在索引路径上）
```

### 身份：asset 行 vs item 逻辑条目
- **asset 行**的身份是规范化路径 `path_norm`（`normalizePath`：小写 + 正斜杠 + NFC，见 §4）。同一路径再次出现 = 同一 asset 行；size/mtime 变化只把 `index_state` 置回 `pending`（`scan.ts:396-406`）。
- **item** 是逻辑条目（一个商品 / 一次建档），一个 item 可挂多个 asset。
- **新建 asset**：`path_norm` 在库中不存在时（`upsertAsset` 的 created 分支）。
- **item 合并**：只有显式调用 `POST /api/items/merge`（`routes.ts:1313` → `repo.mergeItems`，`repo.ts:576`）才会发生；它把 source 的 **assets** 迁到 target（`movedAssets`），**图片不迁**（`movedImages` 恒为 0，source 的图留在 source、不混进 target）；target 原本没有封面时只用 target 自己的第一张图补封面（`repo.ts:586-589`）；item_avatars 取并集（人工 / 已确认优先），标签 / 更新历史 / 快照 / 导入登记归 target，source 软删进回收站（可恢复）。
- **BOOTH 图集与默认图**：`importBoothUrl` 至少下到一张图时，在同一事务里删掉该条目 `origin='archive'` 的默认图（压缩包抽帧 / 包预览），并把封面设为第一张 BOOTH 图（`booth.ts:42-71`）；一张都没下到时不动现有图与封面。`origin='user'` 的人工图保留原 origin/role，只在 `source_url` 为空时补 BOOTH 地址（`booth.ts:49-51`）。源压缩包 / 原素材文件始终只读，不因抓图被改写。
- **路径相同或名称相似不是合并依据**：`services/dedupe.ts` 只计算签名 / 相似度用于展示候选，不自动合并；自动流程不会调用 `mergeItems`。

### 只读边界（仅限索引）
- 索引路径对原包只读：列目录、读单条目、算哈希、抽缩略图都不写源文件。
- 这不等于"产品所有文件操作都只读"：导入 Unity、下载、回收站删除、合并等是显式写操作，各有自己的入口。

### 人工数据 vs 派生索引
- 人工数据：item 字段、分类、标签、manual / confirmed 的适配关系、收藏等。
- 派生索引：archive_entries、unitypackage_assets、缩略图、签名、FTS、缓存。派生数据可重建；人工数据不可被自动任务覆盖（边界见下条）。

### 自动保护的真实边界（精确）
- `matchItem` 的 manual / confirmed 保护**只覆盖 `item_avatars`**：`protectedIds` 由 `source !== "auto"` 的行构成（`match.ts:47-48`），item 级循环跳过它们（`:70-76`）。
- **`asset_avatars` 没有同等保护**：该表无 source 列，`match.ts:79-90` 对每个识别到的 avatar 无条件 upsert。
- 因此不要承诺"全库 / 全关系自动保护"；需要保护 asset 级关系时只能靠人工复核或后续实现。

### 限额与"完整"的含义
- 目录 `complete=true` 与 `contentReadLimited=true` **可以同时成立**：目录列全了，但内容读取（哈希 / 预览 / 缩略图）触到 `maxTotalReadBytes` 等预算。
- `limited` 是"基础记录在、没做完整解析"，**不会**自动提高预算、自动解压或自动触发 Unity 导入。
- `limitsHash` 确实进入 archive / unitypackage 目录缓存键（`stages.ts:221-235`、`:307-315`；`cache.ts:37`；`limits.ts:141`）：改 `limits` 必须同时评估缓存键变化。
- 缓存的内容采样（首尾各 64 KiB + 文件大小）**不是全文件完整性校验**：只覆盖采样范围；全文件完整性走 `sha256`（`stageHash`，`stages.ts:173`）那条独立路径。

## 1. 写作用域（互斥，严禁越界）
| 成员 | 可写 | 禁止 |
|---|---|---|
| lead | `apps/server/**`、`packages/core/src/contracts.ts`、`package.json`、`scripts/**`、`docs/*.md`（verification 除外） | 其他人的文件 |
| core-identify | `packages/core/src/identify.ts`、`pathnorm.ts`、`source/**`、`avatars/**`、`packages/core/test/identify/**`、`packages/core/test/avatars/**` | 其它一切 |
| core-content | `packages/core/src/archive/**`、`unitypackage.ts`、`images.ts`、`hash.ts`、`packages/core/test/content/**` | 其它一切 |
| web-ui | `apps/web/**` | 其它一切 |
| verifier | `test/**`、`docs/verification/**` | 其它一切（尤其不得改被测源码） |

## 2. 命令

> 下列命令均取自 `package.json` 的 scripts（已核对存在）。**本文档轮次未运行任何一条**；它们是产品测试 / 构建入口，不是本次文档验证的证据。
- 安装依赖：**只在 lead 侧跑**（`npm install`，cache 在 `<repo>/.npm-cache`）。
- 跑测试：`node scripts/test.mjs`（等价 `node --import tsx --test <files>`）；单文件：`node --import tsx --test packages/core/test/xxx/yyy.test.ts`。
- 类型检查：`npx tsc --noEmit`。
- 前端构建：`npx vite build --config apps/web/vite.config.ts`。
- 服务：`npx tsx apps/server/src/main.ts`（端口 7317）；长跑必须后台 + 重定向日志。

## 3. 长命令纪律（本机硬上限 60s）
预计 >60s 的命令：`run_in_background: true` 且 `> <repo>/logs/<名字>.log 2>&1`；成员会话的后台作业**不跨回合存活**，所以要么把整个测量序列放在同一回合内完成（起作业后本回合内 `job_output({wait:true, timeout_ms:≤60000})` 有界等待到落盘），要么串成一个后台作业。同一时刻只跑一个重负载任务。

## 4. 冻结的模块接口（签名必须一致，lead 的 server 正在按此调用）
```ts
// packages/core/src/pathnorm.ts  (core-identify)
export function normalizePath(p: string): string;      // 小写 + 正斜杠 + NFC
export function toWinLongPath(p: string): string;      // >260 时加 \\?\ 前缀
export function isSubPath(child: string, parent: string): boolean;
export function basename(p: string): string;
export function extOf(p: string): string;

// packages/core/src/identify.ts  (core-identify)
export function extractItemIds(text: string): string[];
export function identifyFromUrl(url: string): IdentifyCandidate | null;
export function identifyFromNames(names: string[], downloadableNames?: string[]): IdentifyResult;
export function boothUrl(itemId: string, locale?: string): string;

// packages/core/src/source/booth.ts  (core-identify)
export function parseBoothUrl(url: string): { itemId: string; canonicalUrl: string } | null;
export function isHtmlLoginPage(buf: Buffer, contentType?: string | null): boolean;
export class BoothClient {
  constructor(opts?: BoothFetchOptions);
  fetchItem(itemId: string): Promise<BoothItemMeta>;            // GET https://booth.pm/ja/items/<id>.json
  fetchImage(url: string): Promise<{ bytes: Buffer; contentType: string | null }>;
}

// packages/core/src/avatars/detect.ts + normalize.ts  (core-identify)
export function normAlias(s: string): string;
export function buildAliasIndex(known: KnownAvatar[]): Map<string, string>;
export function parseDeclaredCount(text: string): number | null;
export function detectAvatars(input: AvatarDetectionInput, known: KnownAvatar[]): AvatarDetectionResult;
export function avatarNamesFromPaths(paths: string[], known: KnownAvatar[]): { name: string; prefix: string }[];

// packages/core/src/archive/list.ts  (core-content)
export async function listArchive(file: string, opts?: { maxEntries?: number }): Promise<ArchiveListing>;
export async function readArchiveEntry(file: string, entryPath: string, maxBytes?: number): Promise<Buffer>;

// packages/core/src/unitypackage.ts  (core-content)
export async function listUnityPackage(file: string, opts?: { maxAssets?: number }): Promise<UnityPackageListing>;
export async function readUnityPackagePreview(file: string, guid: string): Promise<Buffer | null>;

// packages/core/src/hash.ts, images.ts  (core-content)
export async function sha256File(file: string): Promise<string>;
export async function makeThumbnail(src: Buffer, opts: { maxSize: number; format?: "webp" | "jpeg" }): Promise<{ data: Buffer; width: number; height: number; format: string }>;
export async function probeImage(src: Buffer): Promise<{ width: number; height: number; format: string }>;
```
导入路径统一用相对路径（`../../packages/core/src/...`）或 `@core/...`（tsconfig alias 已配）。跨目录 import 一律用 `.js` 后缀的 ESM 写法**不用**，直接写 `./contracts`（tsx/vite 能解析）。

## 5. 已验证的本机事实（可直接依赖，不必重新发现）
- BOOTH `https://booth.pm/ja/items/<id>.json` **免登录**可用；字段：`name, description, price, published_at, is_adult, images[]{original,resized}, tags[]{name}, category{name,parent{name}}, shop{name,subdomain}, variations[]{id,price,downloadable.no_musics[]{name,file_name,file_extension,file_size,url}}`。
- `https://booth.pm/downloadables/<id>?variation_id=<vid>` 无 cookie → 302 到 `/users/sign_in`；**未登录时直接下会拿到 200 的登录页 HTML**，必须用魔数识别并丢弃。
- `booth.pximg.net` 图片免登录可下。
- `.unitypackage` = gzip tar，条目形如 `<guid>/{asset,asset.meta,pathname,preview.png}`；`pathname` 是 `Assets/...` 路径。真实样本 `%LIBRARY%/MANUKA_ver1.02/MANUKA.unitypackage`（91301427 字节 / 678 条目 / 165 GUID）。
- 本机**没有** 7z/unzip/rar 可执行文件（Windows 也没装 7-Zip）→ 7z/rar 必须用 npm `7zip-bin` 自带二进制（`7zip-bin` 默认导出 `{ path7za }`）。
- 素材样本目录：`%LIBRARY%/素材库`、`%DOWNLOADS%`；文件名语料含 `【12アバター対応】`、`[19 Avatars]`、`Loli_Shinano_6115428 对应1.01.zip`。
- 端口 3080/1933/8888/5432 已占用，本服务用 **7317**。
- npm registry 可达；`npm_config_cache` 必须指向仓内目录（`/root/.npm` 不可写）。
