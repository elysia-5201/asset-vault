/**
 * stage token 的原子 commit 与只读 stage 下载（spec §5.4 / §6.4 / §9.1）。
 *
 * commit 顺序（P2-1/P2-2/P2-4）：
 *  1) 事务外：解码 token 取 nonce → 按 nonce 查回执（回执优先于签名/epoch/TTL/文件/归属）。
 *  2) 事务外：验签 + epoch + TTL + realpath 根边界 + stat(size/mtime) + 重算 sha256。
 *  3) BEGIN IMMEDIATE：按 nonce 重查回执（同 token 200 / 异 token 409）→ 解析目标 item →
 *     path_norm 归属门 → NULL 指针 INSERT 回执 → 建/复用 item → upsertAsset → UPDATE 指针。
 *     事务内无 await；任一步失败整体回滚，nonce 未消费，可重试。
 *  4) 提交后 best-effort attach（只附加元数据/图片，不建 item、不迁 asset owner、不改回执）。
 *
 * stageDownload 只做：下载（注入/真实）→ stat + 真实 sha256 → 只读 precheck → 只读 booth.fetchItem
 * → 发 token。不写 items/assets/item_images/tags/categories，不建 job，不调用 importBoothUrl。
 */
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { AppError, type BoothItemMeta, type ContainerKind } from "../../../../packages/core/src/contracts";
import { sha256FileChunked } from "../../../../packages/core/src/hash";
import { isSubPath, normalizePath } from "../../../../packages/core/src/pathnorm";
import type { BoothClient } from "../../../../packages/core/src/source/booth";
import { parseBoothUrl } from "../../../../packages/core/src/source/booth";
import type { Repo } from "../db/repo";
import { sha256Text } from "../util";
import { attachBoothMetadata } from "./booth";
import { downloadBoothFile, isAllowedBoothUrl, type DownloadResult } from "./download";
import { assertNoForeignOwner } from "./import-files";
import type { MediaStore } from "./media";
import { precheckPaths, type PrecheckResponse } from "./precheck";
import { decodeStageTokenPayload, type StageTokenCodec, type StageTokenPayload } from "./stage-token";

export type StageDecision = "import" | "skip";

export interface StageReceiptReplay {
  replayed: true;
  decision: StageDecision;
  itemId: number | null;
  assetId: number | null;
}
export interface StageCommitImported {
  replayed: false;
  decision: "import";
  itemId: number;
  assetId: number;
}
export interface StageCommitSkipped {
  replayed: false;
  decision: "skip";
  skipped: true;
}
export type CommitResult = StageReceiptReplay | StageCommitImported | StageCommitSkipped;

export type ReceiptLookup =
  | { kind: "none" }
  | { kind: "replay"; decision: StageDecision; itemId: number | null; assetId: number | null }
  | { kind: "conflict" };

/** attach-only 钩子：只允许给已存在 item 附加元数据/图片；禁止 createItem/moveAssets/改 asset owner。 */
export type StageAttach = (
  repo: Repo,
  media: MediaStore,
  booth: BoothClient,
  itemId: number,
  meta: BoothItemMeta,
) => Promise<void>;

export interface CommitDeps {
  repo: Repo;
  media: MediaStore;
  booth: BoothClient;
  codec: StageTokenCodec;
  log?: (m: string) => void;
  /** 默认 attachBoothMetadata；测试可注入。 */
  attach?: StageAttach;
}

export interface StageDownloadDeps extends CommitDeps {
  dataDir: string;
  /** 下载根；缺省 = dataDir（生产由路由传真实 downloadRoot）。 */
  downloadRoot?: string;
  /** 默认 downloadBoothFile；测试注入 stub，不联网。 */
  download?: (opts: { dlUrl: string; destDir: string; fileName?: string | null; log?: (m: string) => void }) => Promise<DownloadResult>;
}

export interface StageDownloadBody {
  url: string;
  /** 5-9 位 BOOTH 商品号；真实 API 可能给安全整数，运行时统一转字符串校验。 */
  itemId?: string | number | null;
  fileName?: string | null;
  downloadRoot?: string;
}

export interface StageDownloadResult {
  staged: true;
  stageToken: string;
  bytes: number;
  fileName: string;
  precheck: PrecheckResponse;
  meta?: unknown;
}

/** token TTL：30 分钟（spec §6.4）。 */
export const STAGE_TOKEN_TTL_MS = 30 * 60 * 1000;

const CONTAINERS = new Set(["zip", "7z", "rar", "unitypackage"]);

const msg = (e: unknown): string => String((e as Error)?.message ?? e);

const STAGE_ITEM_ID = /^\d{5,9}$/;

const invalidInput = (message: string): AppError => new AppError("INVALID_INPUT", message, 400);

/**
 * body.itemId 只接受 5-9 位数字（真实 API 可能给安全整数，转字符串）；对象/数组/目录分隔/片段一律拒绝。
 * 返回 null 表示未提供。
 */
function parseStageItemId(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  let s: string;
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw < 0) throw invalidInput("itemId 必须是 5-9 位数字");
    s = String(raw);
  } else if (typeof raw === "string") {
    s = raw.trim();
  } else {
    throw invalidInput("itemId 必须是 5-9 位数字");
  }
  if (!STAGE_ITEM_ID.test(s)) throw invalidInput("itemId 必须是 5-9 位数字");
  return s;
}

const consumed = (): AppError =>
  new AppError("CONFLICT", "stage token 的 nonce 已被其他 token 消费", 409, { code: "STAGE_TOKEN_CONSUMED" });
const expired = (): AppError =>
  new AppError("CONFLICT", "stage token 已过期", 410, { code: "STAGE_TOKEN_EXPIRED" });
const fileChanged = (message: string): AppError =>
  new AppError("CONFLICT", message, 409, { code: "STAGE_FILE_CHANGED" });
const deleted = (): AppError =>
  new AppError("CONFLICT", "已提交对象已删除", 410, { code: "STAGE_COMMITTED_OBJECT_DELETED" });

/** 按 nonce 查回执（纯读）。token_hash 不同 → conflict，不返回任何指针。 */
export function lookupReceipt(repo: Repo, nonce: string, tokenHash: string): ReceiptLookup {
  const row = repo.connection
    .prepare("SELECT token_hash, decision, item_id, asset_id FROM import_stage_commits WHERE nonce=?")
    .get(nonce) as { token_hash: string; decision: string; item_id: number | null; asset_id: number | null } | undefined;
  if (!row) return { kind: "none" };
  if (String(row.token_hash) !== tokenHash) return { kind: "conflict" };
  return {
    kind: "replay",
    decision: row.decision === "skip" ? "skip" : "import",
    itemId: row.item_id ?? null,
    assetId: row.asset_id ?? null,
  };
}

/** 回执重放判定：import 指针失联 → 410；skip 空指针 → 合法 200。 */
function replayResult(r: { decision: StageDecision; itemId: number | null; assetId: number | null }): CommitResult {
  if (r.decision === "import" && (r.itemId === null || r.assetId === null)) throw deleted();
  return { replayed: true, decision: r.decision, itemId: r.itemId, assetId: r.assetId };
}

/** 事务内无 await：已在事务中则直接执行，否则开 BEGIN IMMEDIATE。 */
function runImmediate<T>(repo: Repo, fn: () => T): T {
  const db = repo.connection;
  if (db.inTransaction) return fn();
  return db.transaction(fn).immediate();
}

function containerOf(p: string): ContainerKind {
  const ext = extname(p).slice(1).toLowerCase();
  return (CONTAINERS.has(ext) ? ext : "file") as ContainerKind;
}

function titleOf(p: string): string {
  const leaf = basename(p);
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

/** 复用已有根（最长前缀，路径段边界）；没有则登记下载根。 */
function resolveRootId(repo: Repo, pathNorm: string, rootPath: string): number {
  let best: { id: number; path_norm: string } | null = null;
  for (const r of repo.listRoots() as { id: number; path_norm: string }[]) {
    if (!isSubPath(pathNorm, r.path_norm)) continue;
    if (!best || r.path_norm.length > best.path_norm.length) best = r;
  }
  if (best) return best.id;
  return Number((repo.ensureRoot(rootPath, "index_in_place") as { id: number }).id);
}

/** 事务外：realpath 根边界 + stat(size/mtime) + 重算 sha256。 */
async function verifyStagedFile(payload: StageTokenPayload): Promise<void> {
  let realFile: string;
  let realRoot: string;
  try {
    realFile = realpathSync(payload.p);
    realRoot = realpathSync(payload.r);
  } catch {
    throw fileChanged("stage 文件或下载根不存在");
  }
  if (!isSubPath(realFile, realRoot)) throw fileChanged("stage 文件不在下载根内");
  let st;
  try {
    st = statSync(realFile);
  } catch {
    throw fileChanged("stage 文件不可读");
  }
  if (!st.isFile()) throw fileChanged("stage 路径不是普通文件");
  if (st.size !== payload.s) throw fileChanged("stage 文件大小已变化");
  if (st.mtime.toISOString() !== payload.m) throw fileChanged("stage 文件 mtime 已变化");
  const actual = (await sha256FileChunked(realFile)).sha256;
  if (actual.toLowerCase() !== payload.h.toLowerCase()) throw fileChanged("stage 文件内容已变化");
}

/** 事务内主体（同步）：重查回执 → 归属门 → NULL 指针占 nonce → 建/复用 item → upsertAsset → 写指针。 */
function commitInner(deps: CommitDeps, payload: StageTokenPayload, tokenHash: string, decision: StageDecision): CommitResult {
  const repo = deps.repo;
  const db = repo.connection;

  const again = lookupReceipt(repo, payload.n, tokenHash);
  if (again.kind === "replay") return replayResult(again);
  if (again.kind === "conflict") throw consumed();

  const createdAt = new Date().toISOString();
  const insertReceipt = db.prepare(
    "INSERT INTO import_stage_commits(nonce, token_hash, decision, item_id, asset_id, created_at) VALUES (?,?,?,NULL,NULL,?)",
  );

  if (decision === "skip") {
    insertReceipt.run(payload.n, tokenHash, "skip", createdAt);
    return { replayed: false, decision: "skip", skipped: true };
  }

  const pathNorm = normalizePath(payload.p);
  const existingItem = payload.i ? repo.getItemBySource("booth", payload.i) : null;
  // 目标为“新建 item 意图”（null）时，任何既有 owner 都是冲突；同已知商品 target 幂等。
  assertNoForeignOwner(repo, existingItem ? existingItem.id : null, pathNorm);

  insertReceipt.run(payload.n, tokenHash, "import", createdAt);

  const itemId = existingItem
    ? existingItem.id
    : repo.createItem({
        title: titleOf(payload.p),
        source_site: payload.i ? "booth" : "local",
        source_item_id: payload.i,
        status: "inbox",
      }).id;

  const container = containerOf(payload.p);
  const up = repo.upsertAsset({
    item_id: itemId,
    kind: container === "unitypackage" ? "unitypackage" : "archive",
    container,
    path: payload.p,
    path_norm: pathNorm,
    root_id: resolveRootId(repo, pathNorm, payload.r),
    size: payload.s,
    mtime: payload.m,
    discovered_by: "download",
  });
  db.prepare("UPDATE import_stage_commits SET item_id=?, asset_id=? WHERE nonce=?").run(itemId, up.asset.id, payload.n);
  return { replayed: false, decision: "import", itemId, assetId: up.asset.id };
}

/** 提交后 best-effort：只附加元数据/图片；失败只记日志，不回滚回执、不重复登记。 */
async function attachBestEffort(deps: CommitDeps, payload: StageTokenPayload, itemId: number): Promise<void> {
  if (!payload.i) return;
  let meta: BoothItemMeta;
  try {
    meta = await deps.booth.fetchItem(payload.i);
  } catch (e) {
    deps.log?.("stage commit: 元数据抓取失败（已登记，不回滚）: " + msg(e));
    return;
  }
  const attach = deps.attach ?? attachBoothMetadata;
  try {
    await attach(deps.repo, deps.media, deps.booth, itemId, meta);
  } catch (e) {
    deps.log?.("stage commit: attach 失败（已登记，不回滚）: " + msg(e));
  }
}

/**
 * 提交 stage token。回执快路径优先于签名/epoch/TTL/文件/归属检查：
 * 已提交 token 在响应丢失、进程重启、文件或 owner 变化后仍返回旧指针。
 */
export async function commitStageToken(deps: CommitDeps, token: string, decision: StageDecision): Promise<CommitResult> {
  const decoded = decodeStageTokenPayload(token);
  if (!decoded) throw new AppError("CONFLICT", "stage token 格式非法", 410, { code: "STAGE_TOKEN_INVALID" });
  const tokenHash = sha256Text(token);

  const fast = lookupReceipt(deps.repo, decoded.n, tokenHash);
  if (fast.kind === "replay") return replayResult(fast);
  if (fast.kind === "conflict") throw consumed();

  const payload = deps.codec.verify(token);
  if (!Number.isFinite(payload.e) || payload.e < Date.now()) throw expired();
  await verifyStagedFile(payload);

  const result = runImmediate(deps.repo, () => commitInner(deps, payload, tokenHash, decision));
  if (result.replayed === false && result.decision === "import") {
    await attachBestEffort(deps, payload, result.itemId);
  }
  return result;
}

/**
 * 事务内入口（供已持有 BEGIN IMMEDIATE 的调用方复用）：不验签/TTL/文件，只做重查回执与登记。
 * 若当前不在事务中，则自行开 BEGIN IMMEDIATE（测试/直接调用安全）。
 */
export function commitStageTokenInTx(
  deps: CommitDeps,
  payload: StageTokenPayload,
  tokenHash: string,
  decision: StageDecision,
): CommitResult {
  return runImmediate(deps.repo, () => commitInner(deps, payload, tokenHash, decision));
}

/**
 * stage 下载（只读）：下载 → stat + 真实 sha256 → 只读 precheck → 只读 booth.fetchItem → 发 token。
 * 不写 items/assets/item_images/tags/categories，不建 job，不调用 importBoothUrl。
 */
export async function stageDownload(deps: StageDownloadDeps, body: StageDownloadBody): Promise<StageDownloadResult> {
  const url = String(body?.url ?? "");
  if (!isAllowedBoothUrl(url)) {
    throw new AppError("INVALID_INPUT", "只接受 BOOTH 的 https 下载地址", 400);
  }
  const parsed = parseBoothUrl(url);
  const bodyItemId = parseStageItemId(body?.itemId);
  if (bodyItemId && parsed && bodyItemId !== parsed.itemId) {
    throw invalidInput("itemId 与 URL 中的 BOOTH 商品号不一致");
  }
  const itemId = bodyItemId ?? parsed?.itemId ?? null;
  // 服务端配置根是唯一权威：body.downloadRoot 只能与它一致，不能改写下载目录。
  const root = deps.downloadRoot ?? deps.dataDir;
  if (body?.downloadRoot !== undefined && body.downloadRoot !== null) {
    if (typeof body.downloadRoot !== "string" || normalizePath(body.downloadRoot) !== normalizePath(root)) {
      throw invalidInput("downloadRoot 与服务端配置的下载根不一致");
    }
  }
  const destDir = join(root, itemId ? "b" + itemId : "b-unknown");
  const download = deps.download ?? downloadBoothFile;
  const dl = await download({ dlUrl: url, destDir, fileName: body.fileName ?? null, log: deps.log });

  const st = statSync(dl.path);
  if (!st.isFile()) throw new AppError("INVALID_INPUT", "下载结果不是普通文件", 400);
  const hash = (await sha256FileChunked(dl.path)).sha256;
  const precheck = await precheckPaths(
    { repo: deps.repo, log: deps.log },
    { paths: [dl.path], source: itemId ? { site: "booth", itemId } : undefined },
  );

  let meta: unknown;
  if (itemId) {
    try {
      meta = await deps.booth.fetchItem(itemId);
    } catch (e) {
      deps.log?.("stage: 元数据抓取失败（只读预检不受影响）: " + msg(e));
    }
  }

  const stageToken = deps.codec.issue({
    p: dl.path,
    r: root,
    i: itemId,
    s: st.size,
    m: st.mtime.toISOString(),
    h: hash,
    e: Date.now() + STAGE_TOKEN_TTL_MS,
    n: randomUUID(),
  });
  return {
    staged: true,
    stageToken,
    bytes: dl.bytes,
    fileName: dl.fileName,
    precheck,
    ...(meta !== undefined ? { meta } : {}),
  };
}
