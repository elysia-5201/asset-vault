/** 托管缩略图缓存维护路由（独立注册；只从 server.ts 接线）。 */
import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import type { Repo } from "../db/repo";
import { scanMediaCache, previewMediaCache, cleanupMediaCache } from "../services/media-cache";

export function registerMediaCacheRoutes(app: FastifyInstance, deps: { repo: Repo; dataDir: string; log: (m: string) => void }): void {
  const mediaRoot = join(deps.dataDir, "media");
  app.get("/api/media-cache", async () => scanMediaCache(mediaRoot, deps.repo));
  app.post("/api/media-cache/preview", async () => previewMediaCache(mediaRoot, deps.repo));
  app.post("/api/media-cache/cleanup", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.path !== undefined || b.paths !== undefined) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "不接受客户端路径" } });
    if (b.confirm !== true) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "confirm=true 必填" } });
    try { return await cleanupMediaCache(mediaRoot, deps.repo, { token: String(b.token ?? ""), confirm: true }); }
    catch (e) { return reply.status(400).send({ error: { code: "INVALID_INPUT", message: String((e as Error)?.message ?? e) } }); }
  });
}
