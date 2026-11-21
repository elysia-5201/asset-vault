/**
 * BOOTH 更正 HTTP（task-70；frozen-interface-B1.md）。
 *
 * 只做 HTTP 形状/ID 解析；预览/确认业务在 service 内。
 * 错误复用 core AppError + routes.ts 的 fail；details.code 由 service 提供。
 */
import type { FastifyInstance } from "fastify";
import { AppError } from "../../../../../packages/core/src/contracts";
import type { Repo } from "../../db/repo";
import type { BoothClient } from "../../../../../packages/core/src/source/booth";
import { confirmBoothCorrection, previewBoothCorrection } from "../../services/booth-correction";
import { fail } from "../routes";

export interface BoothCorrectionRouteDeps {
  repo: Repo;
  booth: Pick<BoothClient, "fetchItem">;
  log?: (m: string) => void;
}

function parseItemId(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new AppError("INVALID_INPUT", "item id 非法", 400);
  return n;
}

export function registerBoothCorrectionRoutes(app: FastifyInstance, deps: BoothCorrectionRouteDeps): void {
  app.post("/api/items/:id/booth-correction/preview", async (req, reply) => {
    try {
      const itemId = parseItemId((req.params as { id?: unknown }).id);
      return await previewBoothCorrection(deps, itemId, req.body);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post("/api/items/:id/booth-correction/confirm", async (req, reply) => {
    try {
      const itemId = parseItemId((req.params as { id?: unknown }).id);
      return await confirmBoothCorrection(deps, itemId, req.body);
    } catch (e) {
      return fail(reply, e);
    }
  });
}
