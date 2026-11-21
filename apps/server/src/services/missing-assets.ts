import { stat } from "node:fs/promises";
import { isAbsolute, parse } from "node:path";
import { AppError, type AssetRow } from "../../../../packages/core/src/contracts";
import { CancelledError, isCancelledError } from "../../../../packages/core/src/abort";
import { sha256FileChunked } from "../../../../packages/core/src/hash";
import { normalizePath } from "../../../../packages/core/src/pathnorm";
import type { Repo } from "../db/repo";
import { now } from "../util";
import { createAssetPathInspector } from "./item-asset-scan";
import { refreshRelocatedUnitFingerprints } from "./structure";

export interface MissingAssetExpectation { expectedPath: string; expectedItemId: number }
export interface RelocationExpectation extends MissingAssetExpectation {
  candidateId: number;
  expectedCandidatePath: string;
  expectedCandidateItemId: number;
}
interface Candidate { assetId: number; itemId: number; title: string; path: string }

const conflict = (message: string) => new AppError("CONFLICT", message, 409);
const changed = () => conflict("文件记录已变化，请刷新素材卡片后重试。");

function getRecord(repo: Repo, id: number) {
  const asset = repo.getAsset(id);
  const owner = asset && repo.itemRow(asset.item_id);
  if (!asset || !owner || owner.status === "trashed") throw new AppError("NOT_FOUND", "文件记录或素材卡片不存在。", 404);
  return asset;
}

function checkSelection(asset: AssetRow, expectedPath: string, expectedItemId: number) {
  if (asset.path !== expectedPath || asset.item_id !== expectedItemId) throw changed();
}

function checkMissing(asset: AssetRow) {
  if (asset.status !== "missing") throw conflict("只有标记为缺失的记录可以整理，请先扫描本条。");
}

function verifiedHash(asset: AssetRow) {
  return asset.container !== "dir" && asset.sha256_state === "ok" && asset.sha256 && /^[0-9a-f]{64}$/i.test(asset.sha256)
    ? asset.sha256.toLowerCase() : null;
}

export function relocationCandidates(repo: Repo, id: number): { candidates: Candidate[]; reason?: string } {
  const source = getRecord(repo, id);
  checkMissing(source);
  const hash = verifiedHash(source);
  if (!hash) return { candidates: [], reason: "旧记录没有可核对的 SHA-256，无法根据内容重新定位。" };
  const candidates = repo.connection.prepare(`
    SELECT a.id AS assetId, a.item_id AS itemId, i.title, a.path
    FROM assets a JOIN items i ON i.id=a.item_id
    WHERE a.sha256 IS NOT NULL AND a.sha256=? COLLATE NOCASE AND a.sha256_state='ok' AND a.size=?
      AND a.status='present' AND a.container<>'dir' AND a.id<>? AND i.status<>'trashed'
    ORDER BY (a.item_id=?) DESC, i.title, a.path, a.id
  `).all(hash, source.size, id, source.item_id) as Candidate[];
  return candidates.length ? { candidates } : {
    candidates, reason: "已登记的文件中没有内容相同的副本。可以先把新位置的文件加入素材库，再重试查找。",
  };
}

async function verifyOldPath(repo: Repo, asset: AssetRow) {
  const result = await createAssetPathInspector(repo)(asset);
  if (result.state !== "missing") throw conflict(result.reason ?? "旧路径的文件已重新出现，请扫描本条刷新状态。");
}

// 文件读取期间允许其他任务运行，写入前在同一事务内重读双方的归属和内容身份。
function verifyRecord(repo: Repo, original: AssetRow) {
  const current = getRecord(repo, original.id);
  if (current.status !== original.status || current.item_id !== original.item_id || current.path !== original.path ||
    current.path_norm !== original.path_norm || current.root_id !== original.root_id || current.size !== original.size ||
    current.mtime !== original.mtime || current.sha256 !== original.sha256 || current.sha256_state !== original.sha256_state ||
    current.container !== original.container) throw changed();
  const busy = repo.connection.prepare(`
    SELECT 1 FROM index_tasks WHERE asset_id=? AND state='running'
    UNION ALL
    SELECT 1 FROM import_runs r JOIN import_plan_items pi ON pi.plan_id=r.plan_id WHERE r.status='running' AND pi.asset_id=?
    LIMIT 1
  `).get(current.id, current.id);
  if (busy) throw conflict("该文件正在索引或导入，请在任务完成后重试。");
}

// 历史记录通过资产 ID 引用此行。释放唯一的路径键，保留当时的可读路径与所有外键。
function retire(repo: Repo, asset: AssetRow, replacedBy?: number) {
  const key = replacedBy === undefined ? "assetvault:removed:" + asset.id : "assetvault:replaced:" + asset.id;
  repo.connection.prepare("UPDATE assets SET status='trashed', path_norm=? WHERE id=?").run(key, asset.id);
  repo.logAudit(replacedBy === undefined ? "asset.remove_missing" : "asset.replaced", "asset", String(asset.id),
    { itemId: asset.item_id, path: asset.path, status: asset.status }, { status: "trashed", replacedBy });
}

export async function removeMissingAsset(repo: Repo, id: number, expected: MissingAssetExpectation) {
  const source = getRecord(repo, id);
  checkSelection(source, expected.expectedPath, expected.expectedItemId);
  if (source.status === "trashed" && source.path_norm === "assetvault:removed:" + id) return { ok: true };
  checkMissing(source);
  await verifyOldPath(repo, source);
  repo.transaction(() => {
    verifyRecord(repo, source);
    retire(repo, source);
    repo.connection.prepare("UPDATE items SET updated_at=? WHERE id=?").run(now(), source.item_id);
  });
  return { ok: true };
}

async function statCandidate(candidate: AssetRow) {
  const path = candidate.path;
  if (!isAbsolute(path) || (process.platform === "win32" && parse(path).root.length === 1))
    throw conflict("候选记录的路径不完整，请重新登记文件。");
  const st = await stat(path).catch(() => null);
  if (!st?.isFile() || st.size !== candidate.size) throw conflict("候选文件已变化或不可读取，请扫描其所在位置后重试。");
  return st;
}

export async function relocateMissingAsset(repo: Repo, id: number, expected: RelocationExpectation, signal?: AbortSignal) {
  const source = getRecord(repo, id);
  checkSelection(source, expected.expectedPath, expected.expectedItemId);
  checkMissing(source);
  const candidate = getRecord(repo, expected.candidateId);
  checkSelection(candidate, expected.expectedCandidatePath, expected.expectedCandidateItemId);
  const hash = verifiedHash(source);
  const newKey = normalizePath(candidate.path);
  if (candidate.id === id || newKey === normalizePath(source.path) || candidate.status !== "present" ||
    !hash || verifiedHash(candidate) !== hash || source.size !== candidate.size)
    throw conflict("候选记录与缺失文件的内容不匹配，请重新查找。");

  const before = await statCandidate(candidate);
  let actual;
  try { actual = await sha256FileChunked(candidate.path, { signal }); }
  catch (err) {
    if (isCancelledError(err)) throw err;
    throw conflict("无法读取候选文件，请检查文件和磁盘后重试。");
  }
  if (actual.sha256 !== hash || actual.bytes !== source.size) throw conflict("候选文件的实际内容与旧记录不同，请重新索引候选文件。");
  await verifyOldPath(repo, source);
  const after = await statCandidate(candidate);
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs) throw conflict("候选文件在核对期间发生变化，请重试。");
  if (signal?.aborted) throw new CancelledError("已取消重新定位。");
  repo.transaction(() => {
    verifyRecord(repo, source);
    verifyRecord(repo, candidate);
    const pathOwner = repo.getAssetByPathNorm(newKey);
    if (pathOwner && pathOwner.id !== candidate.id) throw conflict("新路径已有其他文件登记，请刷新卡片后重试。");
    if (repo.connection.prepare("SELECT 1 FROM asset_version_links WHERE asset_a_id=? OR asset_b_id=? LIMIT 1").get(candidate.id, candidate.id))
      throw conflict("候选文件有关联的版本记录。可以保留候选文件并移除旧记录，或先在候选素材中处理版本关系。");
    retire(repo, candidate, source.id);
    const at = now();
    repo.connection.prepare(`
      UPDATE assets SET path=?, path_norm=?, root_id=?, mtime=?, status='present', last_verified_at=? WHERE id=?
    `).run(candidate.path, newKey, candidate.root_id, after.mtime.toISOString(), at, source.id);
    const updatedSource = repo.getAsset(source.id);
    if (updatedSource) refreshRelocatedUnitFingerprints(repo, source, updatedSource);
    repo.connection.prepare("UPDATE items SET updated_at=? WHERE id IN (?,?)").run(at, source.item_id, candidate.item_id);
    repo.logAudit("asset.relocate", "asset", String(source.id), { itemId: source.item_id, path: source.path },
      { path: candidate.path, candidateId: candidate.id, candidateItemId: candidate.item_id, sha256: hash });
  });
  return { ok: true };
}
