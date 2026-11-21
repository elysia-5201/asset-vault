/**
 * SALT 首次确认：POST /api/items/:id/register-avatar（task-49）。
 *
 * 只做 HTTP 形状/ID 解析；DB 校验与写入在 service 的同步 transaction 内。
 * 成功 200 { avatarId, created }；错误复用 core AppError + routes.ts 的 fail。
 */
import type { FastifyInstance } from "fastify";
import { AppError } from "../../../../../packages/core/src/contracts";
import type { Repo } from "../../db/repo";
import { registerAvatar } from "../../services/avatar-registration";
import { fail } from "../routes";

export interface AvatarRegistrationRouteDeps {
  repo: Repo;
  log?: (m: string) => void;
}

function parseItemId(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new AppError("INVALID_INPUT", "item id 非法", 400);
  return n;
}

export function registerAvatarRegistrationRoutes(app: FastifyInstance, deps: AvatarRegistrationRouteDeps): void {
  app.post("/api/items/:id/register-avatar", async (req, reply) => {
    try {
      const itemId = parseItemId((req.params as { id?: unknown }).id);
      return registerAvatar(deps.repo, itemId, req.body);
    } catch (e) {
      return fail(reply, e);
    }
  });
}
