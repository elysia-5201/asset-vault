/**
 * 按模型搭配清单 HTTP 端点（avatar-loadouts spec §6.1/§6.2/§6.3）。
 *
 * 独立注册模块：只注册本 feature 的端点，不改总 routes.ts 入口（P1T5 集成）。
 * 真实 DTO owner：清单项响应带真实 ItemCard（经 repo.getItem 公共能力投影），
 * 不把 DB 行硬断言成 web DTO，也不调用 repo 私有 toCard；证据/state/version 原样透出。
 * 错误复用 core AppError + routes.ts 的 fail（details.code 子码），不新增外层 enum。
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { AppError, type ItemCard } from "../../../../../packages/core/src/contracts";
import type { Repo } from "../../db/repo";
import {
  addLoadoutItems,
  createLoadout,
  deleteLoadout,
  getLoadout,
  listLoadouts,
  patchLoadout,
  patchLoadoutItem,
  removeLoadoutItem,
  reorderLoadoutItems,
  type AddLoadoutItemsInput,
  type CreateLoadoutInput,
  type LoadoutEvidence,
  type LoadoutItemRow,
  type LoadoutState,
  type LoadoutSummaryRow,
  type PatchLoadoutInput,
  type PatchLoadoutItemInput,
} from "../../db/loadouts";
import { fail } from "../routes";

export interface LoadoutRouteDeps {
  repo: Repo;
  /** 与其它路由模块一致的日志钩子（500 栈由 routes.ts 的 fail 记录）。 */
  log?: (m: string) => void;
}

/** 清单项响应（web LoadoutItem：行 + 只读证据 + 真实卡片）。 */
export interface LoadoutItemResponse {
  itemId: number;
  state: LoadoutState;
  note: string | null;
  position: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  evidence: LoadoutEvidence;
  item: ItemCard;
}

const invalid = (message: string): AppError => new AppError("INVALID_INPUT", message, 400);

function parseId(raw: unknown, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw invalid(label + " 非法");
  return n;
}

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw invalid("请求体必须是对象");
  return body as Record<string, unknown>;
}

function parseQueryInt(raw: unknown, label: string): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" && typeof raw !== "number") throw invalid(label + " 非法");
  const n = Number(raw);
  if (!Number.isFinite(n)) throw invalid(label + " 非法");
  return n;
}

/** includeTrashedItems 只接受 0|1（spec §6.2）；缺省 0。 */
function parseFlag(raw: unknown, label: string): boolean {
  if (raw === undefined || raw === null || raw === "") return false;
  if (raw === "1" || raw === 1 || raw === true) return true;
  if (raw === "0" || raw === 0 || raw === false) return false;
  throw invalid(label + " 只接受 0|1");
}

/** 真实卡片：复用 repo.getItem 公共能力，只投影 ItemCard 字段（不带 images/assets 明细）。 */
function cardOf(repo: Repo, itemId: number): ItemCard {
  const detail = repo.getItem(itemId);
  if (!detail) throw new Error("清单项引用的条目不存在（数据不一致）: " + itemId);
  return {
    id: detail.id,
    title: detail.title,
    sourceSite: detail.sourceSite,
    sourceItemId: detail.sourceItemId,
    sourceUrl: detail.sourceUrl,
    shopName: detail.shopName,
    status: detail.status,
    favorite: detail.favorite,
    adult: detail.adult,
    coverImageId: detail.coverImageId,
    coverUrl: detail.coverUrl,
    imageCount: detail.imageCount,
    assetCount: detail.assetCount,
    totalBytes: detail.totalBytes,
    avatars: detail.avatars,
    tags: detail.tags,
    compatDeclaredCount: detail.compatDeclaredCount,
    collections: detail.collections,
    category: detail.category,
    suggestion: detail.suggestion,
    updatedAt: detail.updatedAt,
  };
}

function itemResponse(repo: Repo, row: LoadoutItemRow): LoadoutItemResponse {
  return {
    itemId: row.itemId,
    state: row.state,
    note: row.note,
    position: row.position,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    evidence: row.evidence,
    item: cardOf(repo, row.itemId),
  };
}

/** 统一错误出口：非 AppError（500）先记路由级上下文，再交给 routes.ts 的 fail（含栈）。 */
function handle(deps: LoadoutRouteDeps, reply: FastifyReply, e: unknown): FastifyReply {
  if (!(e instanceof AppError)) deps.log?.("loadout route failed: " + String((e as Error)?.message ?? e));
  return fail(reply, e);
}

/** 单行响应形状 = 列表项形状（含 itemCount/stateCounts/trashedCount/version/createdAt）。 */
function summaryOf(repo: Repo, avatarId: number, id: number): LoadoutSummaryRow {
  const row = listLoadouts(repo, avatarId).find((l) => l.id === id);
  if (!row) throw new Error("清单刚写入却读不到: " + id);
  return row;
}

export function registerLoadoutRoutes(app: FastifyInstance, deps: LoadoutRouteDeps): void {
  // 纯读：按 sort,id；itemCount 只计活跃行。
  app.get("/api/avatars/:id/loadouts", async (req, reply) => {
    try {
      const avatarId = parseId((req.params as { id?: string }).id, "avatarId");
      return { loadouts: listLoadouts(deps.repo, avatarId) };
    } catch (e) {
      return handle(deps, reply, e);
    }
  });

  app.post("/api/avatars/:id/loadouts", async (req, reply) => {
    try {
      const avatarId = parseId((req.params as { id?: string }).id, "avatarId");
      const body = asObject(req.body);
      const row = createLoadout(deps.repo, avatarId, body as unknown as CreateLoadoutInput);
      return reply.status(201).send({ loadout: summaryOf(deps.repo, row.avatarId, row.id) });
    } catch (e) {
      return handle(deps, reply, e);
    }
  });

  // 纯读详情：墓碑行永不返回；includeTrashedItems 只指 item 在回收站。
  app.get("/api/loadouts/:id", async (req, reply) => {
    try {
      const id = parseId((req.params as { id?: string }).id, "id");
      const q = (req.query ?? {}) as Record<string, unknown>;
      const state = q.state;
      if (state !== undefined && typeof state !== "string") throw invalid("state 非法");
      const detail = getLoadout(deps.repo, id, {
        state: state as LoadoutState | undefined,
        includeTrashedItems: parseFlag(q.includeTrashedItems, "includeTrashedItems"),
        limit: parseQueryInt(q.limit, "limit"),
        offset: parseQueryInt(q.offset, "offset"),
      });
      return {
        loadout: detail.loadout,
        total: detail.total,
        stateCounts: detail.stateCounts,
        visibleStateCounts: detail.visibleStateCounts,
        trashedCount: detail.trashedCount,
        items: detail.items.map((row) => itemResponse(deps.repo, row)),
      };
    } catch (e) {
      return handle(deps, reply, e);
    }
  });

  // 只保护 name/note/sort；成员增删不 bump 清单 version。
  app.patch("/api/loadouts/:id", async (req, reply) => {
    try {
      const id = parseId((req.params as { id?: string }).id, "id");
      const body = asObject(req.body);
      const row = patchLoadout(deps.repo, id, body as unknown as PatchLoadoutInput);
      return { loadout: summaryOf(deps.repo, row.avatarId, row.id) };
    } catch (e) {
      return handle(deps, reply, e);
    }
  });

  // 只删清单与清单项（FK 级联）；不删 item/asset/文件。
  app.delete("/api/loadouts/:id", async (req, reply) => {
    try {
      const id = parseId((req.params as { id?: string }).id, "id");
      return deleteLoadout(deps.repo, id);
    } catch (e) {
      return handle(deps, reply, e);
    }
  });

  // 幂等添加：已有活跃行不覆盖 state/note/position；墓碑行复活到末尾。
  app.post("/api/loadouts/:id/items", async (req, reply) => {
    try {
      const id = parseId((req.params as { id?: string }).id, "id");
      const body = asObject(req.body);
      const out = addLoadoutItems(deps.repo, id, body as unknown as AddLoadoutItemsInput);
      return {
        added: out.added,
        revived: out.revived,
        existing: out.existing,
        items: out.items.map((row) => itemResponse(deps.repo, row)),
      };
    } catch (e) {
      return handle(deps, reply, e);
    }
  });

  // 静态段优先于 :itemId；两者方法不同，无冲突。
  app.post("/api/loadouts/:id/items/reorder", async (req, reply) => {
    try {
      const id = parseId((req.params as { id?: string }).id, "id");
      const body = asObject(req.body);
      const out = reorderLoadoutItems(deps.repo, id, body.itemIds as number[]);
      return { items: out.items.map((row) => itemResponse(deps.repo, row)) };
    } catch (e) {
      return handle(deps, reply, e);
    }
  });

  app.patch("/api/loadouts/:id/items/:itemId", async (req, reply) => {
    try {
      const params = req.params as { id?: string; itemId?: string };
      const loadoutId = parseId(params.id, "loadoutId");
      const itemId = parseId(params.itemId, "itemId");
      const body = asObject(req.body);
      const row = patchLoadoutItem(deps.repo, loadoutId, itemId, body as unknown as PatchLoadoutItemInput);
      return { item: itemResponse(deps.repo, row) };
    } catch (e) {
      return handle(deps, reply, e);
    }
  });

  // 墓碑删除：缺 loadout/item 实体 404；无行/已墓碑 removed:0（幂等，version 不再增）。
  app.delete("/api/loadouts/:id/items/:itemId", async (req, reply) => {
    try {
      const params = req.params as { id?: string; itemId?: string };
      const loadoutId = parseId(params.id, "loadoutId");
      const itemId = parseId(params.itemId, "itemId");
      return removeLoadoutItem(deps.repo, loadoutId, itemId);
    } catch (e) {
      return handle(deps, reply, e);
    }
  });
}
