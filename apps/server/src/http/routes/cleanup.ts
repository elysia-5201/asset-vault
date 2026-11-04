/**
 * 整理待办 HTTP 端点（cleanup-todos spec §6.1/§6.2/§6.3，P4-T3）。
 *
 * 独立注册模块：只注册本 feature 的 8 个端点，不改总 routes.ts 入口（P4-T4 集成）。
 * 真实 DTO owner：todos/ignores/filters 直接返回 cleanup store 的已实现形状，
 * 不复制 repo 私有投影、不虚造卡片、不新增外层 enum/deps/传输框架。
 * 错误复用 core AppError + routes.ts 的 fail（details.code 子码），不新增外层 enum。
 *
 * 三个必填策略入口（spec §6.1/§6.2/§6.3）：
 * - GET /api/cleanup/todos
 * - GET /api/cleanup/ignores
 * - POST/PATCH /api/cleanup/filters 中提供的 filter 对象
 * 三者都先 parseLocalSourcePolicy，再解析其余参数；缺失/非法 → 400 INVALID_INPUT
 * + details.code=LOCAL_POLICY_REQUIRED，无服务端默认。无关端点（GET filters、DELETE、
 * POST ignore、name-only PATCH）不另造必填 query。
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { AppError } from "../../../../../packages/core/src/contracts";
import type { Repo } from "../../db/repo";
import {
  createCleanupFilter,
  deleteCleanupFilter,
  deleteCleanupIgnore,
  listCleanupFilters,
  listCleanupIgnores,
  listCleanupTodos,
  parseLocalSourcePolicy,
  patchCleanupFilter,
  upsertCleanupIgnore,
  type CleanupFilterCreateInput,
  type CleanupFilterPatchInput,
  type CleanupIgnoredMode,
  type CleanupIgnoreInput,
  type CleanupIgnoreQuery,
  type CleanupQuery,
  type CleanupRule,
  type CleanupSort,
} from "../../db/cleanup";
import { fail } from "../routes";

export interface CleanupRouteDeps {
  repo: Repo;
  /** 与其它路由模块一致的日志钩子（500 栈由 routes.ts 的 fail 记录）。 */
  log?: (m: string) => void;
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

/** 逗号分隔 / 重复键都接受；非正整数 token 丢弃（与 /api/items 的 avatar 解析同口径）。 */
function parseCsvNumbers(raw: unknown): number[] | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((s) => String(s ?? "").split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  const nums = parts.map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0);
  return nums.length > 0 ? nums : undefined;
}

/** 逗号分隔 / 重复键都接受；空 token 丢弃。 */
function parseCsvStrings(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((s) => String(s ?? "").split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

/**
 * POST/PATCH filters 的 filter 对象必须先过策略校验（spec §6.3：localSourcePolicy 必填）。
 * 只在 filter 是对象时前置；非对象交给 store 的 validateCleanupFilter 报「filter 必须是对象」。
 */
function requireFilterPolicy(filter: unknown): void {
  if (filter !== null && typeof filter === "object" && !Array.isArray(filter)) {
    parseLocalSourcePolicy((filter as Record<string, unknown>).localSourcePolicy);
  }
}

/** 统一错误出口：非 AppError（500）先记路由级上下文，再交给 routes.ts 的 fail（含栈）。 */
function handle(deps: CleanupRouteDeps, reply: FastifyReply, e: unknown): FastifyReply {
  if (!(e instanceof AppError)) deps.log?.("cleanup route failed: " + String((e as Error)?.message ?? e));
  return fail(reply, e);
}

export function registerCleanupRoutes(app: FastifyInstance, deps: CleanupRouteDeps): void {
  // 纯读：total=当前列表行数；counts=规则命中（不受 rule/ignored 过滤）。
  app.get("/api/cleanup/todos", async (req, reply) => {
    try {
      const q = (req.query ?? {}) as Record<string, unknown>;
      const policy = parseLocalSourcePolicy(q.localSourcePolicy);
      const query: CleanupQuery = {
        localSourcePolicy: policy,
        rule: q.rule as CleanupRule | undefined,
        ignored: q.ignored as CleanupIgnoredMode | undefined,
        q: typeof q.q === "string" ? q.q : undefined,
        avatarIds: parseCsvNumbers(q.avatar),
        categoryIds: parseCsvStrings(q.category),
        sort: q.sort as CleanupSort | undefined,
        limit: parseQueryInt(q.limit, "limit"),
        offset: parseQueryInt(q.offset, "offset"),
      };
      return listCleanupTodos(deps.repo, query);
    } catch (e) {
      return handle(deps, reply, e);
    }
  });

  // 纯读：独立管理视图，含 archived/trashed；resolved 按请求策略单条求值。
  app.get("/api/cleanup/ignores", async (req, reply) => {
    try {
      const q = (req.query ?? {}) as Record<string, unknown>;
      const policy = parseLocalSourcePolicy(q.localSourcePolicy);
      const query: CleanupIgnoreQuery = {
        localSourcePolicy: policy,
        resolved: q.resolved as "any" | "true" | "false" | undefined,
        limit: parseQueryInt(q.limit, "limit"),
        offset: parseQueryInt(q.offset, "offset"),
      };
      return listCleanupIgnores(deps.repo, query);
    } catch (e) {
      return handle(deps, reply, e);
    }
  });

  // 幂等 upsert；只写 cleanup_ignores。返回行的 resolved 按 include_local 视图求值
  // （store 无策略入参）；UI 需按用户所选策略刷新时，用 GET /api/cleanup/ignores 重读。
  app.post("/api/cleanup/ignore", async (req, reply) => {
    try {
      const body = asObject(req.body);
      const row = upsertCleanupIgnore(deps.repo, body as unknown as CleanupIgnoreInput);
      return { ignore: row };
    } catch (e) {
      return handle(deps, reply, e);
    }
  });

  // 恢复 = 删忽略行；幂等 0/1，不 404。
  app.delete("/api/cleanup/ignore/:itemId/:rule", async (req, reply) => {
    try {
      const params = req.params as { itemId?: string; rule?: string };
      return deleteCleanupIgnore(deps.repo, Number(params.itemId), params.rule as CleanupRule);
    } catch (e) {
      return handle(deps, reply, e);
    }
  });

  // 纯读；保存筛选本身已带 localSourcePolicy，列表端点不另造必填 query。
  app.get("/api/cleanup/filters", async (_req, reply) => {
    try {
      return listCleanupFilters(deps.repo);
    } catch (e) {
      return handle(deps, reply, e);
    }
  });

  // filter 对象必填策略；同名 409；结构非法 400。
  app.post("/api/cleanup/filters", async (req, reply) => {
    try {
      const body = asObject(req.body);
      requireFilterPolicy(body.filter);
      const row = createCleanupFilter(deps.repo, body as unknown as CleanupFilterCreateInput);
      return reply.status(201).send({ filter: row });
    } catch (e) {
      return handle(deps, reply, e);
    }
  });

  // name-only PATCH 不要求策略；替换 filter 对象仍必须自带策略；CAS 失败/同名 409。
  app.patch("/api/cleanup/filters/:id", async (req, reply) => {
    try {
      const id = parseId((req.params as { id?: string }).id, "id");
      const body = asObject(req.body);
      if (body.filter !== undefined) requireFilterPolicy(body.filter);
      const row = patchCleanupFilter(deps.repo, id, body as unknown as CleanupFilterPatchInput);
      return { filter: row };
    } catch (e) {
      return handle(deps, reply, e);
    }
  });

  // 幂等 0/1，不 404。
  app.delete("/api/cleanup/filters/:id", async (req, reply) => {
    try {
      const id = parseId((req.params as { id?: string }).id, "id");
      return deleteCleanupFilter(deps.repo, id);
    } catch (e) {
      return handle(deps, reply, e);
    }
  });
}
