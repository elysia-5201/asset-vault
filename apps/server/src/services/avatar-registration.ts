/**
 * SALT 首次确认：原子模型建档/复用 + 条目 manual 关联（task-49）。
 *
 * 所有 DB 校验与写入都在 repo.transaction 内同步完成；不跨 await。
 * 新建：normKey 冲突 → 409 details.code=AVATAR_NAME_CONFLICT/AVATAR_ALIAS_CONFLICT；
 * 复用：existingAvatarId 必须存在，owned=true 设 1，false 不撤销已有 1。
 * 失败（别名/关联/owned）整体回滚，不留档案/别名/关系残余。
 */
import { AppError, normKey, type AvatarRow } from "../../../../packages/core/src/contracts";
import type { Repo } from "../db/repo";

export interface RegisterAvatarResult { avatarId: number; created: boolean }

type Json = Record<string, unknown>;

const invalid = (message: string): AppError => new AppError("INVALID_INPUT", message, 400);
const notFound = (message: string): AppError => new AppError("NOT_FOUND", message, 404);

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function requireOwned(v: unknown): boolean {
  if (typeof v !== "boolean") throw invalid("owned 必须是 boolean");
  return v;
}

function requireName(v: unknown): string {
  if (typeof v !== "string") throw invalid("name 必须是字符串");
  const name = v.trim();
  if (!normKey(name)) throw invalid("name 归一化后为空");
  return name;
}

function requireAliases(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw invalid("aliases 必须是字符串数组");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (typeof raw !== "string") throw invalid("aliases 必须是字符串数组");
    const alias = raw.trim();
    const norm = normKey(alias);
    if (!norm) throw invalid("alias 归一化后为空");
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(alias);
  }
  return out;
}

function requireExistingId(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw invalid("existingAvatarId 必须是正整数");
  return v;
}

function conflict(code: "AVATAR_NAME_CONFLICT" | "AVATAR_ALIAS_CONFLICT", existing: { id: number; name: string }, message: string): AppError {
  return new AppError("CONFLICT", message, 409, { code, avatarId: existing.id, avatarName: existing.name });
}

function isUnique(e: unknown): boolean {
  return String((e as { code?: string })?.code ?? "").includes("SQLITE_CONSTRAINT_UNIQUE");
}

export function registerAvatar(repo: Repo, itemId: number, body: unknown): RegisterAvatarResult {
  return repo.transaction(() => {
    if (!isObject(body)) throw invalid("请求体必须是对象");
    const hasName = Object.prototype.hasOwnProperty.call(body, "name");
    const hasAliases = Object.prototype.hasOwnProperty.call(body, "aliases");
    const hasExisting = Object.prototype.hasOwnProperty.call(body, "existingAvatarId");
    if (hasExisting && (hasName || hasAliases)) throw invalid("existingAvatarId 不得与 name/aliases 混传");
    const allowed = hasExisting ? new Set(["existingAvatarId", "owned"]) : new Set(["name", "aliases", "owned"]);
    for (const key of Object.keys(body)) if (!allowed.has(key)) throw invalid("未知字段: " + key);
    const owned = requireOwned(body.owned);
    const item = repo.getItem(itemId);
    if (!item) throw notFound("条目不存在: " + itemId);
    if (hasExisting) {
      const existingId = requireExistingId(body.existingAvatarId);
      const avatar = repo.getAvatar(existingId);
      if (!avatar) throw notFound("avatar 不存在: " + existingId);
      if (owned) repo.updateAvatar(existingId, { owned: 1 });
      repo.setItemAvatars(itemId, [existingId], "manual", "any", 1);
      return { avatarId: existingId, created: false };
    }
    if (!hasName) throw invalid("name 必填（或提供 existingAvatarId）");
    const name = requireName(body.name);
    const aliases = requireAliases(body.aliases);
    const nameNorm = normKey(name);
    const nameHit = repo.findAvatarByAlias(nameNorm);
    if (nameHit) throw conflict("AVATAR_NAME_CONFLICT", nameHit, "已存在同名/同别名 avatar: " + nameHit.name);
    const aliasNorms = new Set<string>();
    for (const alias of aliases) {
      const an = normKey(alias);
      if (an === nameNorm || aliasNorms.has(an)) continue;
      aliasNorms.add(an);
      const hit = repo.findAvatarByAlias(an);
      if (hit) throw conflict("AVATAR_ALIAS_CONFLICT", hit, "别名已被 " + hit.name + " 占用（待确认，不静默合并）");
    }
    const boothItemId = item.item.source_site === "booth" && item.item.source_item_id && /^\d{5,9}$/.test(item.item.source_item_id)
      ? item.item.source_item_id : null;
    let avatar: AvatarRow;
    try {
      avatar = repo.createAvatar({ name, owned, boothItemId });
    } catch (e) {
      if (isUnique(e)) {
        const hit = repo.findAvatarByAlias(nameNorm);
        if (hit) throw conflict("AVATAR_NAME_CONFLICT", hit, "已存在同名/同别名 avatar: " + hit.name);
      }
      throw e;
    }
    for (const alias of aliases) {
      const an = normKey(alias);
      if (an === nameNorm) continue;
      try {
        repo.addAlias(avatar.id, alias, null, "user");
      } catch (e) {
        if (isUnique(e)) {
          const hit = repo.findAvatarByAlias(an);
          if (hit) throw conflict("AVATAR_ALIAS_CONFLICT", hit, "别名已被 " + hit.name + " 占用（待确认，不静默合并）");
        }
        throw e;
      }
    }
    repo.setItemAvatars(itemId, [avatar.id], "manual", "any", 1);
    return { avatarId: avatar.id, created: true };
  });
}
