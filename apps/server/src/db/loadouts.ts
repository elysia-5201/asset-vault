/**
 * 按模型搭配清单的数据访问（avatar-loadouts spec §5.1/§5.2/§6/§8）。
 *
 * 纯 DB 层：不注册路由、不写 items/assets、不写 project_imports/project_refs/import_runs。
 * - 状态键 (loadout_id, item_id)；删除是墓碑（deleted_at + version+1），不物理删行、不改 key。
 * - 复活：deleted_at=NULL、version+1、position=MAX(活跃行)+1；旧 expectedVersion 必然 409（ABA）。
 * - loadouts.version 只保护 name/note/sort；成员增删不 bump。
 * - counts 三口径：stateCounts（整份清单，含回收站 item）、visibleStateCounts（item 不在回收站）、
 *   trashedCount（item 在回收站）；墓碑行在任何口径下都不计。
 * - 证据只读派生（project_imports / project_refs / import_runs），不因证据变化写 state。
 */
import type Database from "better-sqlite3";
import { AppError } from "../../../../packages/core/src/contracts";
import { now } from "../util";
import type { Repo } from "./repo";

export type LoadoutState = "planned" | "imported" | "verified";

export interface LoadoutStateCounts {
  planned: number;
  imported: number;
  verified: number;
}

export interface LoadoutRow {
  id: number;
  avatarId: number;
  name: string;
  note: string | null;
  sort: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LoadoutSummaryRow extends LoadoutRow {
  itemCount: number;
  stateCounts: LoadoutStateCounts;
  trashedCount: number;
}

export interface LoadoutEvidence {
  registered: boolean;
  referenced: boolean;
  verified: boolean;
  registeredAt: string | null;
  referencedAt: string | null;
  verifiedAt: string | null;
}

export interface LoadoutItemRow {
  loadoutId: number;
  itemId: number;
  state: LoadoutState;
  note: string | null;
  position: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  evidence: LoadoutEvidence;
}

export interface LoadoutDetailRow {
  loadout: LoadoutSummaryRow;
  total: number;
  stateCounts: LoadoutStateCounts;
  visibleStateCounts: LoadoutStateCounts;
  trashedCount: number;
  items: LoadoutItemRow[];
}

export interface LoadoutQuery {
  state?: LoadoutState;
  includeTrashedItems?: boolean;
  limit?: number;
  offset?: number;
}

export interface CreateLoadoutInput {
  name: string;
  note?: string | null;
}

export interface PatchLoadoutInput {
  name?: string;
  note?: string | null;
  sort?: number;
  expectedVersion: number;
}

export interface AddLoadoutItemsInput {
  itemIds: number[];
  state?: LoadoutState;
  note?: string | null;
}

export interface PatchLoadoutItemInput {
  state?: LoadoutState;
  note?: string | null;
  position?: number;
  expectedVersion: number;
}

const STATES = new Set<LoadoutState>(["planned", "imported", "verified"]);

const invalid = (message: string): AppError => new AppError("INVALID_INPUT", message, 400);
const notFound = (message: string): AppError => new AppError("NOT_FOUND", message, 404);
const conflict = (message: string, code: string): AppError => new AppError("CONFLICT", message, 409, { code });

interface RawLoadoutRow {
  id: number;
  avatar_id: number;
  name: string;
  note: string | null;
  sort: number;
  version: number;
  created_at: string;
  updated_at: string;
}

interface RawItemRow {
  loadout_id: number;
  item_id: number;
  state: LoadoutState;
  note: string | null;
  position: number;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface RawActiveItemRow extends RawItemRow {
  status: string;
}

const EMPTY_EVIDENCE: LoadoutEvidence = {
  registered: false, referenced: false, verified: false,
  registeredAt: null, referencedAt: null, verifiedAt: null,
};

function toLoadoutRow(r: RawLoadoutRow): LoadoutRow {
  return {
    id: r.id,
    avatarId: r.avatar_id,
    name: r.name,
    note: r.note,
    sort: r.sort,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toItemRow(r: RawItemRow, evidence: LoadoutEvidence): LoadoutItemRow {
  return {
    loadoutId: r.loadout_id,
    itemId: r.item_id,
    state: r.state,
    note: r.note,
    position: r.position,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    evidence,
  };
}

function requirePositiveInt(v: unknown, label: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw invalid(label + " 必须是正整数");
  return v;
}

function validateName(v: unknown): string {
  if (typeof v !== "string") throw invalid("name 必须是字符串");
  const s = v.trim();
  const len = Array.from(s).length;
  if (len < 1 || len > 80) throw invalid("name 长度必须为 1..80 字符");
  return s;
}

/** undefined/null → null；字符串 ≤500 字符。 */
function validateNote(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw invalid("note 必须是字符串");
  if (Array.from(v).length > 500) throw invalid("note 不能超过 500 字符");
  return v;
}

function validateState(v: unknown): LoadoutState {
  if (typeof v !== "string" || !STATES.has(v as LoadoutState)) throw invalid("state 非法");
  return v as LoadoutState;
}

function validateSort(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw invalid("sort 必须是整数");
  return v;
}

function validatePosition(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw invalid("position 必须是非负整数");
  return v;
}

function clampInt(v: number | undefined, dflt: number, min: number, max: number, label: string): number {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isFinite(v)) throw invalid(label + " 非法");
  const n = Math.floor(v);
  if (n < min) throw invalid(label + " 非法");
  return Math.min(n, max);
}

function requireLoadout(db: Database.Database, id: number): RawLoadoutRow {
  const row = db.prepare("SELECT * FROM loadouts WHERE id=?").get(id) as RawLoadoutRow | undefined;
  if (!row) throw notFound("清单不存在");
  return row;
}

function getLoadoutRow(db: Database.Database, id: number): LoadoutRow {
  return toLoadoutRow(requireLoadout(db, id));
}

/** 三口径计数：stateCounts 含回收站 item；visibleStateCounts 不含；trashedCount 只数回收站 item。 */
function countsFor(db: Database.Database, loadoutId: number): {
  itemCount: number;
  stateCounts: LoadoutStateCounts;
  visibleStateCounts: LoadoutStateCounts;
  trashedCount: number;
} {
  const rows = db.prepare(
    "SELECT li.state AS state, COUNT(*) AS n, " +
    "SUM(CASE WHEN i.status='trashed' THEN 1 ELSE 0 END) AS trashed " +
    "FROM loadout_items li JOIN items i ON i.id=li.item_id " +
    "WHERE li.loadout_id=? AND li.deleted_at IS NULL GROUP BY li.state",
  ).all(loadoutId) as { state: LoadoutState; n: number; trashed: number }[];
  const stateCounts: LoadoutStateCounts = { planned: 0, imported: 0, verified: 0 };
  const visibleStateCounts: LoadoutStateCounts = { planned: 0, imported: 0, verified: 0 };
  let itemCount = 0;
  let trashedCount = 0;
  for (const r of rows) {
    const n = Number(r.n);
    const trashed = Number(r.trashed);
    stateCounts[r.state] += n;
    visibleStateCounts[r.state] += n - trashed;
    itemCount += n;
    trashedCount += trashed;
  }
  return { itemCount, stateCounts, visibleStateCounts, trashedCount };
}

function summaryOf(db: Database.Database, raw: RawLoadoutRow): LoadoutSummaryRow {
  const c = countsFor(db, raw.id);
  return { ...toLoadoutRow(raw), itemCount: c.itemCount, stateCounts: c.stateCounts, trashedCount: c.trashedCount };
}

/** 证据按 item_id 聚合（不按清单）；三张表各一次 IN 查询，避免 N+1。 */
function evidenceFor(db: Database.Database, itemIds: number[]): Map<number, LoadoutEvidence> {
  const out = new Map<number, LoadoutEvidence>();
  for (const id of itemIds) out.set(id, { ...EMPTY_EVIDENCE });
  if (itemIds.length === 0) return out;
  const ph = itemIds.map(() => "?").join(",");
  const registered = db.prepare(
    "SELECT item_id, MAX(imported_at) AS at FROM project_imports WHERE item_id IN (" + ph + ") GROUP BY item_id",
  ).all(...(itemIds as never[])) as { item_id: number; at: string | null }[];
  for (const r of registered) {
    const e = out.get(r.item_id);
    if (e) { e.registered = true; e.registeredAt = r.at; }
  }
  const referenced = db.prepare(
    "SELECT item_id, MAX(scanned_at) AS at FROM project_refs WHERE item_id IN (" + ph + ") GROUP BY item_id",
  ).all(...(itemIds as never[])) as { item_id: number; at: string | null }[];
  for (const r of referenced) {
    const e = out.get(r.item_id);
    if (e) { e.referenced = true; e.referencedAt = r.at; }
  }
  const verified = db.prepare(
    "SELECT p.item_id AS item_id, MAX(r.finished_at) AS at FROM import_runs r " +
    "JOIN import_plans p ON p.id=r.plan_id WHERE r.status='verified' AND p.item_id IN (" + ph + ") GROUP BY p.item_id",
  ).all(...(itemIds as never[])) as { item_id: number; at: string | null }[];
  for (const r of verified) {
    const e = out.get(r.item_id);
    if (e) { e.verified = true; e.verifiedAt = r.at; }
  }
  return out;
}

function itemRow(db: Database.Database, loadoutId: number, itemId: number): LoadoutItemRow {
  const raw = db.prepare("SELECT * FROM loadout_items WHERE loadout_id=? AND item_id=?").get(loadoutId, itemId) as RawItemRow | undefined;
  if (!raw) throw notFound("清单项不存在");
  return toItemRow(raw, evidenceFor(db, [itemId]).get(itemId) ?? { ...EMPTY_EVIDENCE });
}

function activeItems(db: Database.Database, loadoutId: number): RawActiveItemRow[] {
  return db.prepare(
    "SELECT li.*, i.status AS status FROM loadout_items li JOIN items i ON i.id=li.item_id " +
    "WHERE li.loadout_id=? AND li.deleted_at IS NULL ORDER BY li.position, li.item_id",
  ).all(loadoutId) as RawActiveItemRow[];
}

function itemsWithEvidence(db: Database.Database, rows: RawItemRow[]): LoadoutItemRow[] {
  const ev = evidenceFor(db, rows.map((r) => r.item_id));
  return rows.map((r) => toItemRow(r, ev.get(r.item_id) ?? { ...EMPTY_EVIDENCE }));
}

/** 建清单：name trim 后 1..80；同模型同名（NOCASE）409；空名 400。 */
export function createLoadout(repo: Repo, avatarId: number, input: CreateLoadoutInput): LoadoutRow {
  const avatar = requirePositiveInt(avatarId, "avatarId");
  const name = validateName(input?.name);
  const note = validateNote(input?.note);
  const db = repo.connection;
  return repo.transaction(() => {
    if (!db.prepare("SELECT 1 FROM avatars WHERE id=?").get(avatar)) throw notFound("模型不存在");
    const at = now();
    let id: number;
    try {
      id = Number(db.prepare(
        "INSERT INTO loadouts(avatar_id,name,note,sort,version,created_at,updated_at) VALUES (?,?,?,0,1,?,?)",
      ).run(avatar, name, note, at, at).lastInsertRowid);
    } catch (e) {
      const code = String((e as { code?: string }).code ?? "");
      if (code.startsWith("SQLITE_CONSTRAINT") && code.includes("UNIQUE")) {
        throw conflict("同名清单已存在", "LOADOUT_NAME_TAKEN");
      }
      throw e;
    }
    repo.logAudit("loadout.create", "loadout", String(id), null, { avatarId: avatar, name, note });
    return getLoadoutRow(db, id);
  });
}

/** 纯读：按 sort,id；itemCount 只计活跃行；stateCounts 含回收站 item。 */
export function listLoadouts(repo: Repo, avatarId: number): LoadoutSummaryRow[] {
  const avatar = requirePositiveInt(avatarId, "avatarId");
  const db = repo.connection;
  if (!db.prepare("SELECT 1 FROM avatars WHERE id=?").get(avatar)) throw notFound("模型不存在");
  const rows = db.prepare("SELECT * FROM loadouts WHERE avatar_id=? ORDER BY sort, id").all(avatar) as RawLoadoutRow[];
  return rows.map((r) => summaryOf(db, r));
}

/** 纯读详情：墓碑行永不返回；includeTrashedItems 只指 item 在回收站。 */
export function getLoadout(repo: Repo, id: number, q: LoadoutQuery = {}): LoadoutDetailRow {
  const lid = requirePositiveInt(id, "id");
  const state = q.state === undefined ? undefined : validateState(q.state);
  const includeTrashed = q.includeTrashedItems === true;
  const limit = clampInt(q.limit, 100, 1, 500, "limit");
  const offset = clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset");
  const db = repo.connection;
  const raw = requireLoadout(db, lid);
  const where = "li.loadout_id=? AND li.deleted_at IS NULL" +
    (state !== undefined ? " AND li.state=?" : "") +
    (includeTrashed ? "" : " AND i.status<>'trashed'");
  const params: unknown[] = state !== undefined ? [lid, state] : [lid];
  const total = Number((db.prepare(
    "SELECT COUNT(*) AS n FROM loadout_items li JOIN items i ON i.id=li.item_id WHERE " + where,
  ).get(...(params as never[])) as { n: number }).n);
  const rows = db.prepare(
    "SELECT li.* FROM loadout_items li JOIN items i ON i.id=li.item_id WHERE " + where +
    " ORDER BY li.position, li.item_id LIMIT ? OFFSET ?",
  ).all(...(params as never[]), limit, offset) as RawItemRow[];
  const c = countsFor(db, lid);
  return {
    loadout: summaryOf(db, raw),
    total,
    stateCounts: c.stateCounts,
    visibleStateCounts: c.visibleStateCounts,
    trashedCount: c.trashedCount,
    items: itemsWithEvidence(db, rows),
  };
}

/** 改清单自身字段：CAS 在 no-op 之前；同名 409；成员增删不经过这里。 */
export function patchLoadout(repo: Repo, id: number, input: PatchLoadoutInput): LoadoutRow {
  const lid = requirePositiveInt(id, "id");
  const expectedVersion = requirePositiveInt(input?.expectedVersion, "expectedVersion");
  const db = repo.connection;
  return repo.transaction(() => {
    const cur = requireLoadout(db, lid);
    if (cur.version !== expectedVersion) throw conflict("清单已被修改（expectedVersion 过期）", "LOADOUT_VERSION_CONFLICT");
    const nextName = input?.name !== undefined ? validateName(input.name) : cur.name;
    const nextNote = input?.note !== undefined ? validateNote(input.note) : cur.note;
    const nextSort = input?.sort !== undefined ? validateSort(input.sort) : cur.sort;
    if (nextName === cur.name && nextNote === cur.note && nextSort === cur.sort) return toLoadoutRow(cur);
    const at = now();
    const nextVersion = cur.version + 1;
    try {
      const res = db.prepare(
        "UPDATE loadouts SET name=?, note=?, sort=?, version=?, updated_at=? WHERE id=? AND version=?",
      ).run(nextName, nextNote, nextSort, nextVersion, at, lid, expectedVersion) as { changes: number };
      if (res.changes !== 1) throw conflict("清单已被修改（CAS 失败）", "LOADOUT_VERSION_CONFLICT");
    } catch (e) {
      if (e instanceof AppError) throw e;
      const code = String((e as { code?: string }).code ?? "");
      if (code.startsWith("SQLITE_CONSTRAINT") && code.includes("UNIQUE")) {
        throw conflict("同名清单已存在", "LOADOUT_NAME_TAKEN");
      }
      throw e;
    }
    repo.logAudit("loadout.update", "loadout", String(lid),
      { name: cur.name, note: cur.note, sort: cur.sort, version: cur.version },
      { name: nextName, note: nextNote, sort: nextSort, version: nextVersion });
    return getLoadoutRow(db, lid);
  });
}

/** 删清单：只删清单与清单项（FK 级联）；不删 item/asset/文件。 */
export function deleteLoadout(repo: Repo, id: number): { deleted: boolean } {
  const lid = requirePositiveInt(id, "id");
  const db = repo.connection;
  return repo.transaction(() => {
    const cur = requireLoadout(db, lid);
    const res = db.prepare("DELETE FROM loadouts WHERE id=?").run(lid) as { changes: number };
    if (res.changes !== 1) throw notFound("清单不存在");
    repo.logAudit("loadout.delete", "loadout", String(lid), { avatarId: cur.avatar_id, name: cur.name }, null);
    return { deleted: true };
  });
}

/** 幂等添加：已有活跃行不覆盖 state/note/position；墓碑行复活到末尾。 */
export function addLoadoutItems(repo: Repo, loadoutId: number, input: AddLoadoutItemsInput): {
  added: number; revived: number; existing: number; items: LoadoutItemRow[];
} {
  const lid = requirePositiveInt(loadoutId, "loadoutId");
  const rawIds = input?.itemIds;
  if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > 200) throw invalid("itemIds 必须为 1..200 个");
  const ids: number[] = [];
  for (const v of rawIds) {
    const id = requirePositiveInt(v, "itemIds[]");
    if (!ids.includes(id)) ids.push(id);
  }
  // 新行/复活行 state 默认 planned（spec §6.1:148）；note 未显式给时保留墓碑行原值（spec 未规定默认，最小保全）。
  const stateInput = input?.state === undefined ? undefined : validateState(input.state);
  const noteInput = input?.note === undefined ? undefined : validateNote(input.note);
  const db = repo.connection;
  return repo.transaction(() => {
    requireLoadout(db, lid);
    const ph = ids.map(() => "?").join(",");
    const found = db.prepare("SELECT id FROM items WHERE id IN (" + ph + ")").all(...(ids as never[])) as { id: number }[];
    if (found.length !== ids.length) throw notFound("条目不存在");
    const at = now();
    let added = 0;
    let revived = 0;
    let existing = 0;
    for (const itemId of ids) {
      const cur = db.prepare("SELECT * FROM loadout_items WHERE loadout_id=? AND item_id=?").get(lid, itemId) as RawItemRow | undefined;
      if (!cur) {
        db.prepare(
          "INSERT INTO loadout_items(loadout_id,item_id,state,note,position,version,created_at,updated_at,deleted_at) " +
          "VALUES (?,?,?,?,0,1,?,?,NULL)",
        ).run(lid, itemId, stateInput ?? "planned", noteInput ?? null, at, at);
        added += 1;
      } else if (cur.deleted_at === null) {
        existing += 1;
      } else {
        const pos = Number((db.prepare(
          "SELECT COALESCE(MAX(position),-1)+1 AS p FROM loadout_items WHERE loadout_id=? AND deleted_at IS NULL",
        ).get(lid) as { p: number }).p);
        const res = db.prepare(
          "UPDATE loadout_items SET deleted_at=NULL, state=?, note=?, position=?, version=version+1, updated_at=? " +
          "WHERE loadout_id=? AND item_id=? AND deleted_at IS NOT NULL",
        ).run(stateInput ?? "planned", noteInput !== undefined ? noteInput : cur.note, pos, at, lid, itemId) as { changes: number };
        if (res.changes !== 1) throw conflict("清单项已被修改（复活 CAS 失败）", "LOADOUT_ITEM_VERSION_CONFLICT");
        revived += 1;
      }
    }
    repo.logAudit("loadout.item.add", "loadout", String(lid), null,
      { itemIds: ids, state: stateInput ?? null, note: noteInput ?? null, added, revived, existing });
    return { added, revived, existing, items: ids.map((itemId) => itemRow(db, lid, itemId)) };
  });
}

/** 改清单项：墓碑行视为不存在（404）；CAS 失败 409；无实质变化不 bump。 */
export function patchLoadoutItem(repo: Repo, loadoutId: number, itemId: number, input: PatchLoadoutItemInput): LoadoutItemRow {
  const lid = requirePositiveInt(loadoutId, "loadoutId");
  const iid = requirePositiveInt(itemId, "itemId");
  const expectedVersion = requirePositiveInt(input?.expectedVersion, "expectedVersion");
  const nextStateInput = input?.state === undefined ? undefined : validateState(input.state);
  const nextPositionInput = input?.position === undefined ? undefined : validatePosition(input.position);
  const db = repo.connection;
  return repo.transaction(() => {
    requireLoadout(db, lid);
    const cur = db.prepare("SELECT * FROM loadout_items WHERE loadout_id=? AND item_id=?").get(lid, iid) as RawItemRow | undefined;
    if (!cur || cur.deleted_at !== null) throw notFound("清单项不存在");
    // CAS 在 no-op 之前：旧 expectedVersion 即使请求同值也 409。
    if (cur.version !== expectedVersion) throw conflict("清单项已被修改（expectedVersion 过期）", "LOADOUT_ITEM_VERSION_CONFLICT");
    const nextState = nextStateInput ?? cur.state;
    const nextNote = input?.note !== undefined ? validateNote(input.note) : cur.note;
    const nextPosition = nextPositionInput ?? cur.position;
    if (nextState === cur.state && nextNote === cur.note && nextPosition === cur.position) return toItemRow(cur, evidenceFor(db, [iid]).get(iid) ?? { ...EMPTY_EVIDENCE });
    const at = now();
    const nextVersion = cur.version + 1;
    const res = db.prepare(
      "UPDATE loadout_items SET state=?, note=?, position=?, version=?, updated_at=? " +
      "WHERE loadout_id=? AND item_id=? AND version=? AND deleted_at IS NULL",
    ).run(nextState, nextNote, nextPosition, nextVersion, at, lid, iid, expectedVersion) as { changes: number };
    if (res.changes !== 1) throw conflict("清单项已被修改（CAS 失败）", "LOADOUT_ITEM_VERSION_CONFLICT");
    repo.logAudit("loadout.item.update", "loadout_item", lid + ":" + iid,
      { state: cur.state, note: cur.note, position: cur.position, version: cur.version },
      { state: nextState, note: nextNote, position: nextPosition, version: nextVersion });
    return itemRow(db, lid, iid);
  });
}

/**
 * 墓碑删除：先确认 loadout/item 实体存在（缺任一 → 404，零业务写）；
 * 实体存在时成员无行/已墓碑 → removed:0（幂等，version 不再递增）。
 */
export function removeLoadoutItem(repo: Repo, loadoutId: number, itemId: number): { removed: 0 | 1 } {
  const lid = requirePositiveInt(loadoutId, "loadoutId");
  const iid = requirePositiveInt(itemId, "itemId");
  const db = repo.connection;
  return repo.transaction(() => {
    // spec §6.2:156 实体不存在 404；§6.1:150/§8:217 成员 0 行 removed:0。回收站 item 仍是存在实体。
    requireLoadout(db, lid);
    if (!db.prepare("SELECT 1 FROM items WHERE id=?").get(iid)) throw notFound("条目不存在");
    const at = now();
    const res = db.prepare(
      "UPDATE loadout_items SET deleted_at=?, version=version+1, updated_at=? " +
      "WHERE loadout_id=? AND item_id=? AND deleted_at IS NULL",
    ).run(at, at, lid, iid) as { changes: number };
    if (res.changes !== 1) return { removed: 0 };
    repo.logAudit("loadout.item.remove", "loadout_item", lid + ":" + iid, null, { deletedAt: at });
    return { removed: 1 };
  });
}

/**
 * 重排：两种合法形状（可见行 / 全量）；隐藏行按原相对顺序追加；空可见集 [] 为 no-op。
 * 只对 position 实际变化的行 version+1（无实质变化不 bump）。
 */
export function reorderLoadoutItems(repo: Repo, loadoutId: number, itemIds: number[]): { items: LoadoutItemRow[] } {
  const lid = requirePositiveInt(loadoutId, "loadoutId");
  if (!Array.isArray(itemIds)) throw invalid("itemIds 必须是数组");
  const ids: number[] = [];
  for (const v of itemIds) {
    const id = requirePositiveInt(v, "itemIds[]");
    if (ids.includes(id)) throw invalid("itemIds 不能重复");
    ids.push(id);
  }
  const db = repo.connection;
  return repo.transaction(() => {
    requireLoadout(db, lid);
    const active = activeItems(db, lid);
    const byId = new Map<number, RawActiveItemRow>();
    for (const r of active) byId.set(r.item_id, r);
    for (const id of ids) if (!byId.has(id)) throw invalid("itemIds 含不属于该清单的活跃行");
    const visible = active.filter((r) => r.status !== "trashed");
    const hidden = active.filter((r) => r.status === "trashed");
    if (visible.length === 0 && ids.length === 0) return { items: itemsWithEvidence(db, active) };
    const visibleIds = new Set(visible.map((r) => r.item_id));
    const isVisibleShape = ids.length === visible.length && ids.every((id) => visibleIds.has(id));
    const isFullShape = ids.length === active.length;
    if (!isVisibleShape && !isFullShape) throw invalid("reorder 形状非法（少行/多行/含墓碑行）");
    const order = isVisibleShape ? [...ids, ...hidden.map((r) => r.item_id)] : ids;
    const at = now();
    for (let i = 0; i < order.length; i += 1) {
      const row = byId.get(order[i])!;
      if (row.position === i) continue;
      const res = db.prepare(
        "UPDATE loadout_items SET position=?, version=version+1, updated_at=? " +
        "WHERE loadout_id=? AND item_id=? AND version=? AND deleted_at IS NULL",
      ).run(i, at, lid, row.item_id, row.version) as { changes: number };
      if (res.changes !== 1) throw conflict("清单项已被修改（reorder CAS 失败）", "LOADOUT_ITEM_VERSION_CONFLICT");
    }
    repo.logAudit("loadout.item.reorder", "loadout", String(lid), null, { itemIds: order });
    return { items: itemsWithEvidence(db, activeItems(db, lid)) };
  });
}

export interface MergeLoadoutItemsResult {
  conflicts: number;
  revived: number;
  moved: number;
  bothTombstone: number;
  noop: number;
}

/** 合并审计快照：只取六格表关心的字段（原始值，供 before/after 对照）。 */
function mergeSnapshot(r: RawItemRow | undefined): {
  state: LoadoutState; note: string | null; position: number; version: number; deletedAt: string | null;
} | null {
  return r ? { state: r.state, note: r.note, position: r.position, version: r.version, deletedAt: r.deleted_at } : null;
}

/** 合并 CAS：version 必须仍是读到的值，活跃/墓碑状态也必须仍是读到的状态；0 行 → 409，不覆盖。 */
function mergeCas(
  db: Database.Database, loadoutId: number, itemId: number, expectedVersion: number,
  active: boolean, setSql: string, params: unknown[],
): void {
  const res = db.prepare(
    "UPDATE loadout_items SET " + setSql + " WHERE loadout_id=? AND item_id=? AND version=? AND deleted_at IS " +
    (active ? "NULL" : "NOT NULL"),
  ).run(...(params as never[]), loadoutId, itemId, expectedVersion) as { changes: number };
  if (res.changes !== 1) throw conflict("清单项已被修改（合并 CAS 失败）", "LOADOUT_ITEM_VERSION_CONFLICT");
}

/** 合并审计：与业务更新同一事务；at 用调用方给的合并时刻，便于与业务行对齐。 */
function mergeAudit(
  db: Database.Database, at: string, action: string, loadoutId: number, sourceItemId: number, targetItemId: number,
  before: { source: unknown; target: unknown }, after: { source: unknown; target: unknown },
): void {
  db.prepare(
    "INSERT INTO audit_log(at, actor, action, entity, entity_id, before_json, after_json) VALUES (?,?,?,?,?,?,?)",
  ).run(at, "user", action, "loadout", String(loadoutId),
    JSON.stringify({ sourceItemId, targetItemId, ...before }),
    JSON.stringify({ sourceItemId, targetItemId, ...after }));
}

/**
 * 合并 source→target 的清单成员（spec §9.1:233-252 六格表）。
 *
 * - 只处理含 S 或 T（至少一个）的清单；S、T 都不含的清单不受影响。
 * - 不写 items、不 UPDATE item_id、不物理删行；source 活跃转墓碑 +1，source 已墓碑原样保留。
 * - target 行 version = max(合并前 T.version, S.version) + 1；source 无行时 target-only 一律 no-op。
 * - 自带事务（better-sqlite3 嵌套即 savepoint），可与调用者外事务组合；业务更新与审计同事务，
 *   任何失败（含 CAS 0 行、审计写入失败）整体回滚。同步实现，事务内无 await。
 * - 返回计数只覆盖 spec §252 列出的 5 格；target 活跃 + source 墓碑（第 6 格）只 bump target.version，
 *   spec 未给该格 action/counter，故不写审计、不计数（见 P3-T3 报告“最小解释”）。
 */
export function mergeLoadoutItemsTx(
  db: Database.Database, sourceItemId: number, targetItemId: number, at: string,
): MergeLoadoutItemsResult {
  const sourceId = requirePositiveInt(sourceItemId, "sourceItemId");
  const targetId = requirePositiveInt(targetItemId, "targetItemId");
  if (sourceId === targetId) throw invalid("sourceItemId 与 targetItemId 不能相同");
  const out: MergeLoadoutItemsResult = { conflicts: 0, revived: 0, moved: 0, bothTombstone: 0, noop: 0 };
  const run = db.transaction(() => {
    const lids = (db.prepare(
      "SELECT DISTINCT loadout_id FROM loadout_items WHERE item_id IN (?,?) ORDER BY loadout_id",
    ).all(sourceId, targetId) as { loadout_id: number }[]).map((r) => r.loadout_id);
    const read = db.prepare("SELECT * FROM loadout_items WHERE loadout_id=? AND item_id=?");
    const snap = (lid: number, itemId: number) => mergeSnapshot(read.get(lid, itemId) as RawItemRow | undefined);
    for (const lid of lids) {
      const s = read.get(lid, sourceId) as RawItemRow | undefined;
      const t = read.get(lid, targetId) as RawItemRow | undefined;
      const before = { source: mergeSnapshot(s), target: mergeSnapshot(t) };
      // source 无行（target-only）：target 活跃/墓碑都 no-op，不碰 version/position/updated_at，不写审计。
      if (!s) { out.noop += 1; continue; }
      if (!t) {
        if (s.deleted_at !== null) {
          // target 无行 + source 墓碑：不建 target，source 原样保留。
          out.noop += 1;
          mergeAudit(db, at, "loadout.merge_noop", lid, sourceId, targetId, before,
            { source: snap(lid, sourceId), target: null });
          continue;
        }
        // target 无行 + source 活跃：新建 target（取 source state/note/position），source 转墓碑。
        try {
          db.prepare(
            "INSERT INTO loadout_items(loadout_id,item_id,state,note,position,version,created_at,updated_at,deleted_at) " +
            "VALUES (?,?,?,?,?,?,?,?,NULL)",
          ).run(lid, targetId, s.state, s.note, s.position, s.version + 1, at, at);
        } catch (e) {
          const code = String((e as { code?: string }).code ?? "");
          if (code.startsWith("SQLITE_CONSTRAINT")) throw conflict("清单项已被修改（合并并发插入）", "LOADOUT_ITEM_VERSION_CONFLICT");
          throw e;
        }
        mergeCas(db, lid, sourceId, s.version, true, "deleted_at=?, version=?, updated_at=?", [at, s.version + 1, at]);
        out.moved += 1;
        mergeAudit(db, at, "loadout.merge_move", lid, sourceId, targetId, before,
          { source: snap(lid, sourceId), target: snap(lid, targetId) });
        continue;
      }
      const nextVersion = Math.max(t.version, s.version) + 1;
      if (t.deleted_at === null && s.deleted_at === null) {
        // 冲突：target 赢 state/note/position；source 转墓碑。
        mergeCas(db, lid, targetId, t.version, true, "version=?, updated_at=?", [nextVersion, at]);
        mergeCas(db, lid, sourceId, s.version, true, "deleted_at=?, version=?, updated_at=?", [at, s.version + 1, at]);
        out.conflicts += 1;
        mergeAudit(db, at, "loadout.merge_conflict", lid, sourceId, targetId, before,
          { source: snap(lid, sourceId), target: snap(lid, targetId) });
      } else if (t.deleted_at === null) {
        // target 活跃 + source 墓碑：只 bump target；source 全字段原样保留。
        mergeCas(db, lid, targetId, t.version, true, "version=?, updated_at=?", [nextVersion, at]);
      } else if (s.deleted_at === null) {
        // target 墓碑 + source 活跃：复活 target（取 source state/note，position=MAX(活跃行)+1）。
        const pos = Number((db.prepare(
          "SELECT COALESCE(MAX(position),-1)+1 AS p FROM loadout_items WHERE loadout_id=? AND deleted_at IS NULL",
        ).get(lid) as { p: number }).p);
        mergeCas(db, lid, targetId, t.version, false,
          "deleted_at=NULL, state=?, note=?, position=?, version=?, updated_at=?",
          [s.state, s.note, pos, nextVersion, at]);
        mergeCas(db, lid, sourceId, s.version, true, "deleted_at=?, version=?, updated_at=?", [at, s.version + 1, at]);
        out.revived += 1;
        mergeAudit(db, at, "loadout.merge_revive", lid, sourceId, targetId, before,
          { source: snap(lid, sourceId), target: snap(lid, targetId) });
      } else {
        // 双方墓碑：target 仍墓碑，只 bump version；source 原样保留，不产生活跃行。
        mergeCas(db, lid, targetId, t.version, false, "version=?, updated_at=?", [nextVersion, at]);
        out.bothTombstone += 1;
        mergeAudit(db, at, "loadout.merge_both_tombstone", lid, sourceId, targetId, before,
          { source: snap(lid, sourceId), target: snap(lid, targetId) });
      }
    }
  });
  run();
  return out;
}
