/**
 * 版本关系持久化（import-precheck spec §5.1/§6.2/§9.2/§10）。
 *
 * 纯 DB 层：不注册路由、不写 items/assets、不建 job。
 * - POST 规范 asset_a_id < asset_b_id，交换入参时对调 a_newer/b_newer；重复对 409。
 * - PATCH 事务内严格 CAS（expectedVersion 必填，0 行 → 409）；CAS 在 no-op 判定之前。
 * - 同 state/relation 无实质变化才 no-op（不递增、不审计）；relation-only 更正 version+1 并审计，
 *   保留 decided_at/basis/evidence；真实 state 转移 version+1 + decided_at + 审计。
 * - DELETE 任意 state 允许；审计与删除同事务；AUTOINCREMENT 不复用 id。
 */
import type Database from "better-sqlite3";
import { AppError } from "../../../../packages/core/src/contracts";
import { now } from "../util";
import type { Repo } from "./repo";

export type VersionLinkRelation = "a_newer" | "b_newer" | "same" | "companion";
export type VersionLinkBasis = "filename" | "title" | "manual";
export type VersionLinkState = "candidate" | "confirmed" | "revoked";

/** 公开 DTO 的资产引用（P1T4 Minor：至少 id/path/size/mtime，camelCase）。 */
export interface VersionLinkAssetRef {
  id: number;
  path: string;
  size: number;
  mtime: string | null;
}
export interface VersionLinkRow {
  id: number;
  itemId: number;
  assetAId: number;
  assetBId: number;
  relation: VersionLinkRelation;
  basis: VersionLinkBasis;
  state: VersionLinkState;
  evidence: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  assets: { a: VersionLinkAssetRef; b: VersionLinkAssetRef };
}
export interface VersionLinkQuery {
  state?: VersionLinkState;
  limit?: number;
  offset?: number;
}
export interface CreateVersionLinkInput {
  assetAId: number;
  assetBId: number;
  relation: VersionLinkRelation;
  basis?: VersionLinkBasis;
  evidence?: unknown;
}
export interface PatchVersionLinkInput {
  relation?: VersionLinkRelation;
  state?: VersionLinkState;
  expectedVersion: number;
}

const RELATIONS = new Set<VersionLinkRelation>(["a_newer", "b_newer", "same", "companion"]);
const BASES = new Set<VersionLinkBasis>(["filename", "title", "manual"]);
const STATES = new Set<VersionLinkState>(["candidate", "confirmed", "revoked"]);

const invalid = (message: string): AppError => new AppError("INVALID_INPUT", message, 400);
const notFound = (message: string): AppError => new AppError("NOT_FOUND", message, 404);
const conflict = (message: string, code: string): AppError => new AppError("CONFLICT", message, 409, { code });

interface RawRow {
  id: number;
  item_id: number;
  asset_a_id: number;
  asset_b_id: number;
  relation: VersionLinkRelation;
  basis: VersionLinkBasis;
  evidence_json: string | null;
  state: VersionLinkState;
  version: number;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  a_path: string;
  a_size: number;
  a_mtime: string | null;
  b_path: string;
  b_size: number;
  b_mtime: string | null;
}

const SELECT_SQL =
  "SELECT l.id, l.item_id, l.asset_a_id, l.asset_b_id, l.relation, l.basis, l.evidence_json, " +
  "l.state, l.version, l.created_at, l.updated_at, l.decided_at, " +
  "a.path AS a_path, a.size AS a_size, a.mtime AS a_mtime, " +
  "b.path AS b_path, b.size AS b_size, b.mtime AS b_mtime " +
  "FROM asset_version_links l " +
  "JOIN assets a ON a.id = l.asset_a_id " +
  "JOIN assets b ON b.id = l.asset_b_id";

function parseEvidence(raw: string | null): unknown {
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

function toRow(r: RawRow): VersionLinkRow {
  return {
    id: r.id,
    itemId: r.item_id,
    assetAId: r.asset_a_id,
    assetBId: r.asset_b_id,
    relation: r.relation,
    basis: r.basis,
    state: r.state,
    evidence: parseEvidence(r.evidence_json),
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    decidedAt: r.decided_at,
    assets: {
      a: { id: r.asset_a_id, path: r.a_path, size: r.a_size, mtime: r.a_mtime },
      b: { id: r.asset_b_id, path: r.b_path, size: r.b_size, mtime: r.b_mtime },
    },
  };
}

function requirePositiveInt(v: unknown, label: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw invalid(label + " 必须是正整数");
  return v;
}

function getRow(db: Database.Database, id: number, itemId: number): VersionLinkRow {
  const raw = db.prepare(SELECT_SQL + " WHERE l.id=? AND l.item_id=?").get(id, itemId) as RawRow | undefined;
  if (!raw) throw notFound("版本关系不存在");
  return toRow(raw);
}

/** 建候选关系：规范 a<b、逆关系对调、重复对 409、跨 item 400、不存在 404。 */
export function createVersionLink(repo: Repo, itemId: number, input: CreateVersionLinkInput): VersionLinkRow {
  const item = requirePositiveInt(itemId, "itemId");
  const a = requirePositiveInt(input?.assetAId, "assetAId");
  const b = requirePositiveInt(input?.assetBId, "assetBId");
  if (a === b) throw invalid("assetAId 与 assetBId 不能相同");
  const relation = input?.relation;
  if (!relation || !RELATIONS.has(relation)) throw invalid("relation 非法");
  const basis = input?.basis ?? "manual";
  if (!BASES.has(basis)) throw invalid("basis 非法");
  const evidenceJson = input?.evidence === undefined || input?.evidence === null ? null : JSON.stringify(input.evidence);

  let assetAId = a;
  let assetBId = b;
  let normalized: VersionLinkRelation = relation;
  if (a > b) {
    assetAId = b;
    assetBId = a;
    normalized = relation === "a_newer" ? "b_newer" : relation === "b_newer" ? "a_newer" : relation;
  }

  const db = repo.connection;
  return repo.transaction(() => {
    if (!db.prepare("SELECT 1 FROM items WHERE id=?").get(item)) throw notFound("条目不存在");
    const rows = db.prepare("SELECT id, item_id FROM assets WHERE id IN (?,?)").all(assetAId, assetBId) as { id: number; item_id: number }[];
    if (rows.length !== 2) throw notFound("资产不存在");
    for (const r of rows) if (r.item_id !== item) throw invalid("两个资产必须属于同一 item");
    const at = now();
    let id: number;
    try {
      id = Number(db.prepare(
        "INSERT INTO asset_version_links(item_id,asset_a_id,asset_b_id,relation,basis,evidence_json,state,version,created_at,updated_at,decided_at) " +
        "VALUES (?,?,?,?,?,?,'candidate',1,?,?,NULL)",
      ).run(item, assetAId, assetBId, normalized, basis, evidenceJson, at, at).lastInsertRowid);
    } catch (e) {
      const code = String((e as { code?: string }).code ?? "");
      if (code.startsWith("SQLITE_CONSTRAINT")) {
        if (code.includes("UNIQUE")) throw conflict("该资产对已有版本关系", "VERSION_LINK_EXISTS");
        throw invalid("资产关系不合法（同 item 约束）");
      }
      throw e;
    }
    return getRow(db, id, item);
  });
}

/** 确认/更正/撤销：事务内 CAS；无实质变化 no-op；真实变化 version+1 + 审计。 */
export function patchVersionLink(repo: Repo, itemId: number, linkId: number, input: PatchVersionLinkInput): VersionLinkRow {
  const item = requirePositiveInt(itemId, "itemId");
  const id = requirePositiveInt(linkId, "linkId");
  const expectedVersion = requirePositiveInt(input?.expectedVersion, "expectedVersion");
  const nextRelationInput = input?.relation;
  const nextStateInput = input?.state;
  if (nextRelationInput !== undefined && !RELATIONS.has(nextRelationInput)) throw invalid("relation 非法");
  if (nextStateInput !== undefined && !STATES.has(nextStateInput)) throw invalid("state 非法");

  const db = repo.connection;
  return repo.transaction(() => {
    const cur = db.prepare(SELECT_SQL + " WHERE l.id=? AND l.item_id=?").get(id, item) as RawRow | undefined;
    if (!cur) throw notFound("版本关系不存在");
    // CAS 在 no-op 之前：旧 expectedVersion 即使请求同 state 也 409。
    if (cur.version !== expectedVersion) throw conflict("版本关系已被修改（expectedVersion 过期）", "VERSION_CONFLICT");
    const nextState = nextStateInput ?? cur.state;
    const nextRelation = nextRelationInput ?? cur.relation;
    const stateChanged = nextState !== cur.state;
    const relationChanged = nextRelation !== cur.relation;
    if (!stateChanged && !relationChanged) return toRow(cur);

    const at = now();
    const decidedAt = stateChanged ? at : cur.decided_at;
    const nextVersion = cur.version + 1;
    const res = db.prepare(
      "UPDATE asset_version_links SET relation=?, state=?, version=?, updated_at=?, decided_at=? " +
      "WHERE id=? AND item_id=? AND version=?",
    ).run(nextRelation, nextState, nextVersion, at, decidedAt, id, item, expectedVersion) as { changes: number };
    if (res.changes !== 1) throw conflict("版本关系已被修改（CAS 失败）", "VERSION_CONFLICT");

    const action = stateChanged
      ? nextState === "confirmed" ? "version_link.confirm" : nextState === "revoked" ? "version_link.revoke" : "version_link.reopen"
      : "version_link.correct";
    repo.logAudit(
      action,
      "asset_version_link",
      String(id),
      { state: cur.state, relation: cur.relation, version: cur.version },
      { state: nextState, relation: nextRelation, version: nextVersion },
    );
    return getRow(db, id, item);
  });
}

/** 删除任意 state 的关系；审计与删除同事务；不存在 404。 */
export function deleteVersionLink(repo: Repo, itemId: number, linkId: number): { deleted: boolean } {
  const item = requirePositiveInt(itemId, "itemId");
  const id = requirePositiveInt(linkId, "linkId");
  const db = repo.connection;
  return repo.transaction(() => {
    const cur = db.prepare(SELECT_SQL + " WHERE l.id=? AND l.item_id=?").get(id, item) as RawRow | undefined;
    if (!cur) throw notFound("版本关系不存在");
    const res = db.prepare("DELETE FROM asset_version_links WHERE id=? AND item_id=?").run(id, item) as { changes: number };
    if (res.changes !== 1) throw notFound("版本关系不存在");
    repo.logAudit(
      "version_link.delete",
      "asset_version_link",
      String(id),
      { state: cur.state, relation: cur.relation, version: cur.version },
      null,
    );
    return { deleted: true };
  });
}

/** 纯读列表：updated_at DESC,id DESC；state 筛选；total 与筛选一致；默认 50、上限 200；含 trashed item。 */
export function listVersionLinks(repo: Repo, itemId: number, q: VersionLinkQuery = {}): { total: number; links: VersionLinkRow[] } {
  const item = requirePositiveInt(itemId, "itemId");
  const state = q.state;
  if (state !== undefined && !STATES.has(state)) throw invalid("state 非法");
  const limit = clampInt(q.limit, 50, 1, 200, "limit");
  const offset = clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset");
  const db = repo.connection;
  const where = " WHERE l.item_id=?" + (state !== undefined ? " AND l.state=?" : "");
  const params: unknown[] = state !== undefined ? [item, state] : [item];
  const total = Number((db.prepare("SELECT COUNT(*) AS n FROM asset_version_links l" + where).get(...(params as never[])) as { n: number }).n);
  const rows = db.prepare(SELECT_SQL + where + " ORDER BY l.updated_at DESC, l.id DESC LIMIT ? OFFSET ?")
    .all(...(params as never[]), limit, offset) as RawRow[];
  return { total, links: rows.map(toRow) };
}

function clampInt(v: number | undefined, dflt: number, min: number, max: number, label: string): number {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isFinite(v)) throw invalid(label + " 非法");
  const n = Math.floor(v);
  if (n < min) throw invalid(label + " 非法");
  return Math.min(n, max);
}
