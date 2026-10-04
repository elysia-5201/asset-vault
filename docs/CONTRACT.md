# AssetVault 团队契约（FROZEN）

## 0. 现状
仓根 `<repo>`（**新项目，无 git**）。已由 lead 冻结：
- `packages/core/src/contracts.ts` —— 所有共享类型 + 状态机转移表（**只读，禁止改；要改先找 lead**）
- `apps/server/src/db/schema.sql` + `migrate.ts` —— 15 表 + FTS5(trigram)
- `docs/api.md` —— HTTP API v1（冻结）
- `package.json` / `tsconfig.json` / `scripts/test.mjs`（测试入口）

## 1. 写作用域（互斥，严禁越界）
| 成员 | 可写 | 禁止 |
|---|---|---|
| lead | `apps/server/**`、`packages/core/src/contracts.ts`、`package.json`、`scripts/**`、`docs/*.md`（verification 除外） | 其他人的文件 |
| core-identify | `packages/core/src/identify.ts`、`pathnorm.ts`、`source/**`、`avatars/**`、`packages/core/test/identify/**`、`packages/core/test/avatars/**` | 其它一切 |
| core-content | `packages/core/src/archive/**`、`unitypackage.ts`、`images.ts`、`hash.ts`、`packages/core/test/content/**` | 其它一切 |
| web-ui | `apps/web/**` | 其它一切 |
| verifier | `test/**`、`docs/verification/**` | 其它一切（尤其不得改被测源码） |

## 2. 命令
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
