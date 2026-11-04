/**
 * 导入预检 / 版本关系 / stage commit 路由（import-precheck spec §6.1/§6.2/§6.4）。
 *
 * 独立注册模块：只注册本 feature 的新端点，不重复注册旧 POST /api/import/download，
 * 不改总 routes.ts 入口（P1T5 集成）。deps 由调用方构造一次共享 codec（stageDownload 与
 * commit 复用），不在请求内 new 随机 codec；下载根等可信配置由服务端持有。
 */
import type { FastifyInstance } from "fastify";
import { AppError } from "../../../../../packages/core/src/contracts";
import type { BoothClient } from "../../../../../packages/core/src/source/booth";
import type { Repo } from "../../db/repo";
import {
  createVersionLink,
  deleteVersionLink,
  listVersionLinks,
  patchVersionLink,
  type CreateVersionLinkInput,
  type PatchVersionLinkInput,
  type VersionLinkQuery,
  type VersionLinkState,
} from "../../db/version-links";
import type { MediaStore } from "../../services/media";
import { precheckPaths, type PrecheckInput } from "../../services/precheck";
import { commitStageToken, type CommitDeps, type StageAttach, type StageDecision } from "../../services/stage-commit";
import type { StageTokenCodec } from "../../services/stage-token";
import { fail } from "../routes";

export interface ImportPrecheckRouteDeps {
  repo: Repo;
  /** 共享 stage token codec：P1T5 构造一次，stageDownload 与 commit 复用。 */
  codec: StageTokenCodec;
  media: MediaStore;
  booth: BoothClient;
  log?: (m: string) => void;
  /** 测试注入；缺省 commitStageToken 使用真实 attachBoothMetadata。 */
  attach?: StageAttach;
}

const invalid = (message: string): AppError => new AppError("INVALID_INPUT", message, 400);

function parseId(raw: unknown, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw invalid(label + " 非法");
  return n;
}

function parseQueryInt(raw: unknown, label: string): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" && typeof raw !== "number") throw invalid(label + " 非法");
  const n = Number(raw);
  if (!Number.isFinite(n)) throw invalid(label + " 非法");
  return n;
}

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw invalid("请求体必须是对象");
  return body as Record<string, unknown>;
}

export function registerImportPrecheckRoutes(app: FastifyInstance, deps: ImportPrecheckRouteDeps): void {
  const commitDeps: CommitDeps = {
    repo: deps.repo,
    media: deps.media,
    booth: deps.booth,
    codec: deps.codec,
    log: deps.log,
    attach: deps.attach,
  };

  // 预检：纯读（不写库/不建 job/不写缓存）。
  app.post("/api/import/precheck", async (req, reply) => {
    try {
      const body = asObject(req.body);
      return await precheckPaths({ repo: deps.repo, log: deps.log }, body as unknown as PrecheckInput);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get("/api/items/:id/version-links", async (req, reply) => {
    try {
      const itemId = parseId((req.params as { id?: string }).id, "itemId");
      const q = (req.query ?? {}) as Record<string, unknown>;
      const state = q.state;
      if (state !== undefined && typeof state !== "string") throw invalid("state 非法");
      const query: VersionLinkQuery = {
        state: state as VersionLinkState | undefined,
        limit: parseQueryInt(q.limit, "limit"),
        offset: parseQueryInt(q.offset, "offset"),
      };
      const result = listVersionLinks(deps.repo, itemId, query);
      return { itemId, total: result.total, links: result.links };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post("/api/items/:id/version-links", async (req, reply) => {
    try {
      const itemId = parseId((req.params as { id?: string }).id, "itemId");
      const body = asObject(req.body);
      return createVersionLink(deps.repo, itemId, body as unknown as CreateVersionLinkInput);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.patch("/api/items/:id/version-links/:linkId", async (req, reply) => {
    try {
      const params = req.params as { id?: string; linkId?: string };
      const itemId = parseId(params.id, "itemId");
      const linkId = parseId(params.linkId, "linkId");
      const body = asObject(req.body);
      return patchVersionLink(deps.repo, itemId, linkId, body as unknown as PatchVersionLinkInput);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete("/api/items/:id/version-links/:linkId", async (req, reply) => {
    try {
      const params = req.params as { id?: string; linkId?: string };
      const itemId = parseId(params.id, "itemId");
      const linkId = parseId(params.linkId, "linkId");
      return deleteVersionLink(deps.repo, itemId, linkId);
    } catch (e) {
      return fail(reply, e);
    }
  });

  // stage commit：token 校验/重算在事务外；回执/归属/登记由 commitStageToken 负责。
  app.post("/api/import/download/commit", async (req, reply) => {
    try {
      const body = asObject(req.body);
      const token = typeof body.stageToken === "string" ? body.stageToken.trim() : "";
      if (!token) throw invalid("stageToken 必填");
      const decision = body.decision;
      if (decision !== "import" && decision !== "skip") throw invalid("decision 必须是 import|skip");
      return await commitStageToken(commitDeps, token, decision as StageDecision);
    } catch (e) {
      return fail(reply, e);
    }
  });
}
