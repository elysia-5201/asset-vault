/**
 * BOOTH 更正（task-70；frozen-interface-B1.md）。
 *
 * 预览只读；确认在 repo.transaction 内重读旧 binding、检查目标占用、只改来源身份，
 * 同事务写 audit + 新 BOOTH snapshot。网络 fetch 在事务外；任何抛错整体回滚。
 */
import { AppError, type BoothItemMeta, type ItemDetail, type ItemRow, type SourceSite } from "../../../../packages/core/src/contracts";
import { parseBoothUrl, type BoothClient } from "../../../../packages/core/src/source/booth";
import type { Repo } from "../db/repo";
import { now as nowUtil, sha256Text as sha256TextUtil } from "../util";

export interface BoothCorrectionBinding {
  sourceSite: SourceSite | null;
  sourceItemId: string | null;
  sourceUrl: string | null;
  canonicalUrl: string | null;
  sourceGone: boolean;
}

export interface BoothCorrectionTarget {
  itemId: string;
  url: string;
  canonicalUrl: string;
  title: string;
  shop: { name: string; subdomain: string } | null;
  priceText: string | null;
  priceYen: number | null;
  publishedAt: string | null;
  isAdult: boolean;
  category: { name: string; parent: string | null } | null;
  tags: string[];
  imageCount: number;
  fileCount: number;
}

export interface BoothCorrectionPreview {
  itemId: number;
  current: BoothCorrectionBinding;
  target: BoothCorrectionTarget;
  willChange: string[];
  willPreserve: string[];
  conflict: null | { itemId: number; title: string };
}

export interface BoothCorrectionConfirmResult {
  changed: boolean;
  itemId: number;
  previousBinding: BoothCorrectionBinding;
  currentBinding: BoothCorrectionBinding;
  item: ItemDetail;
}

export interface BoothCorrectionDeps {
  repo: Repo;
  booth: Pick<BoothClient, "fetchItem">;
  now?: () => string;
  sha256Text?: (s: string) => string;
}

const SOURCE_SITES = new Set<SourceSite>(["booth", "gumroad", "unity_asset_store", "itch", "other", "local"]);

const WILL_CHANGE = [
  "source_site", "source_item_id", "source_url", "canonical_url", "source_gone",
  "last_checked_at", "updated_at", "source_snapshot", "audit",
];

const WILL_PRESERVE = [
  "title", "title_ja", "shop_name", "shop_subdomain", "author", "price_text", "price_yen",
  "purchased", "purchased_at", "published_at", "category_name", "category_parent", "description",
  "adult", "status", "rating", "favorite", "notes", "cover_image_id", "compat_declared_count",
  "id_confidence", "id_match_method", "cat_id", "cat_sub_id", "cat_source", "cat_confidence",
  "cat_reason", "cat_evidence", "cat_assigned_at", "cat_suggest_id", "cat_suggest_sub_id",
  "cat_suggest_confidence", "cat_suggest_reason", "cat_suggest_evidence", "cat_suggest_at",
  "assets", "tags", "images", "avatars", "collections",
];

function invalid(message: string, code?: string): AppError {
  return new AppError("INVALID_INPUT", message, 400, code ? { code } : undefined);
}

function notFound(itemId: number): AppError {
  return new AppError("NOT_FOUND", "条目不存在: " + itemId, 404, { code: "BOOTH_CORRECTION_ITEM_NOT_FOUND" });
}

function stale(expected: { sourceSite: SourceSite | null; sourceItemId: string | null; sourceUrl: string | null }, actual: BoothCorrectionBinding): AppError {
  return new AppError("CONFLICT", "来源绑定已变化，请重新预览", 409, {
    code: "BOOTH_CORRECTION_STALE",
    expected,
    actual: { sourceSite: actual.sourceSite, sourceItemId: actual.sourceItemId, sourceUrl: actual.sourceUrl },
  });
}

function occupied(owner: ItemRow): AppError {
  return new AppError("CONFLICT", "目标 BOOTH 商品已被其他条目占用", 409, {
    code: "BOOTH_CORRECTION_OCCUPIED", conflictItemId: owner.id, title: owner.title,
  });
}

function targetMismatch(expectedTargetItemId: string, actualTargetItemId: string): AppError {
  return new AppError("CONFLICT", "目标商品号不一致", 409, {
    code: "BOOTH_CORRECTION_TARGET_MISMATCH", expectedTargetItemId, actualTargetItemId,
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function requireObject(v: unknown): Record<string, unknown> {
  if (!isObject(v)) throw invalid("请求体必须是对象");
  return v;
}

function requireOnlyKeys(body: Record<string, unknown>, allowed: string[]): void {
  const set = new Set(allowed);
  for (const key of Object.keys(body)) if (!set.has(key)) throw invalid("未知字段: " + key);
}

function requireUrl(v: unknown): string {
  if (typeof v !== "string") throw invalid("url 必须是字符串");
  return v;
}

function requireNullableString(v: unknown, label: string): string | null {
  if (v === null) return null;
  if (typeof v !== "string") throw invalid(label + " 必须是字符串或 null");
  return v;
}

function requireNullableSourceSite(v: unknown, label: string): SourceSite | null {
  if (v === null) return null;
  if (typeof v !== "string" || !SOURCE_SITES.has(v as SourceSite)) throw invalid(label + " 非法");
  return v as SourceSite;
}

function requireTargetId(v: unknown): string {
  if (typeof v !== "string") throw invalid("expectedTargetItemId 必须是字符串");
  return v;
}

function bindingOf(row: ItemRow): BoothCorrectionBinding {
  return {
    sourceSite: (row.source_site ?? null) as SourceSite | null,
    sourceItemId: row.source_item_id ?? null,
    sourceUrl: row.source_url ?? null,
    canonicalUrl: row.canonical_url ?? null,
    sourceGone: Boolean(row.source_gone),
  };
}

function targetOf(meta: BoothItemMeta, canonicalUrl: string): BoothCorrectionTarget {
  return {
    itemId: meta.itemId,
    url: meta.url,
    canonicalUrl,
    title: meta.title,
    shop: meta.shop ? { name: meta.shop.name, subdomain: meta.shop.subdomain } : null,
    priceText: meta.priceText,
    priceYen: meta.priceYen,
    publishedAt: meta.publishedAt,
    isAdult: meta.isAdult,
    category: meta.category ? { name: meta.category.name, parent: meta.category.parent?.name ?? null } : null,
    tags: meta.tags.map((t) => t.name),
    imageCount: meta.images.length,
    fileCount: meta.variations.reduce((n, v) => n + v.files.length, 0),
  };
}

function snapshotProjection(meta: BoothItemMeta) {
  return {
    itemId: meta.itemId,
    url: meta.url,
    title: meta.title,
    priceText: meta.priceText,
    images: meta.images.map((i) => i.original),
    files: meta.variations.flatMap((v) => v.files.map((f) => f.name)),
  };
}

function snapshotFiles(meta: BoothItemMeta) {
  return meta.variations.flatMap((v) => v.files.map((f) => ({ name: f.name, size: f.file_size ?? null })));
}

function snapshotImageUrls(meta: BoothItemMeta): string[] {
  return meta.images.map((i) => i.original);
}

function isSourceUniqueConflict(e: unknown): boolean {
  const code = String((e as { code?: unknown })?.code ?? "");
  const message = String((e as { message?: unknown })?.message ?? "");
  return code.includes("SQLITE_CONSTRAINT_UNIQUE")
    && message.includes("items.source_site")
    && message.includes("items.source_item_id");
}

export async function previewBoothCorrection(
  deps: BoothCorrectionDeps,
  itemId: number,
  body: unknown,
): Promise<BoothCorrectionPreview> {
  const b = requireObject(body);
  requireOnlyKeys(b, ["url"]);
  const url = requireUrl(b.url);
  const parsed = parseBoothUrl(url);
  if (!parsed) throw invalid("不是有效的 BOOTH 链接", "BOOTH_CORRECTION_INVALID_URL");
  const current = deps.repo.getItem(itemId);
  if (!current) throw notFound(itemId);
  const meta = await deps.booth.fetchItem(parsed.itemId);
  const owner = deps.repo.getItemBySource("booth", parsed.itemId);
  return {
    itemId,
    current: bindingOf(current.item),
    target: targetOf(meta, parsed.canonicalUrl),
    willChange: [...WILL_CHANGE],
    willPreserve: [...WILL_PRESERVE],
    conflict: owner && owner.id !== itemId ? { itemId: owner.id, title: owner.title } : null,
  };
}

export async function confirmBoothCorrection(
  deps: BoothCorrectionDeps,
  itemId: number,
  body: unknown,
): Promise<BoothCorrectionConfirmResult> {
  const b = requireObject(body);
  requireOnlyKeys(b, ["url", "expectedSourceSite", "expectedSourceItemId", "expectedSourceUrl", "expectedTargetItemId", "confirm"]);
  const url = requireUrl(b.url);
  const expectedSourceSite = requireNullableSourceSite(b.expectedSourceSite, "expectedSourceSite");
  const expectedSourceItemId = requireNullableString(b.expectedSourceItemId, "expectedSourceItemId");
  const expectedSourceUrl = requireNullableString(b.expectedSourceUrl, "expectedSourceUrl");
  const expectedTargetItemId = requireTargetId(b.expectedTargetItemId);
  if (b.confirm !== true) throw invalid("confirm 必须为 true");

  const parsed = parseBoothUrl(url);
  if (!parsed) throw invalid("不是有效的 BOOTH 链接", "BOOTH_CORRECTION_INVALID_URL");
  if (expectedTargetItemId !== parsed.itemId) throw targetMismatch(expectedTargetItemId, parsed.itemId);

  const meta = await deps.booth.fetchItem(parsed.itemId);
  if (meta.itemId !== parsed.itemId) throw targetMismatch(expectedTargetItemId, meta.itemId);

  const now = deps.now ?? nowUtil;
  const hash = deps.sha256Text ?? sha256TextUtil;

  try {
    return deps.repo.transaction(() => {
      const current = deps.repo.getItem(itemId);
      if (!current) throw notFound(itemId);
      const actual = bindingOf(current.item);
      const expected = { sourceSite: expectedSourceSite, sourceItemId: expectedSourceItemId, sourceUrl: expectedSourceUrl };
      if (actual.sourceSite !== expected.sourceSite
        || actual.sourceItemId !== expected.sourceItemId
        || actual.sourceUrl !== expected.sourceUrl) {
        throw stale(expected, actual);
      }

      const owner = deps.repo.getItemBySource("booth", parsed.itemId);
      if (owner && owner.id !== itemId) throw occupied(owner);

      const desired = {
        sourceSite: "booth" as const,
        sourceItemId: parsed.itemId,
        sourceUrl: parsed.canonicalUrl,
        canonicalUrl: parsed.canonicalUrl,
        sourceGone: false,
      };
      if (actual.sourceSite === desired.sourceSite
        && actual.sourceItemId === desired.sourceItemId
        && actual.sourceUrl === desired.sourceUrl
        && actual.canonicalUrl === desired.canonicalUrl
        && actual.sourceGone === false) {
        return { changed: false, itemId, previousBinding: actual, currentBinding: actual, item: current };
      }

      const updated = deps.repo.updateItem(itemId, {
        source_site: desired.sourceSite,
        source_item_id: desired.sourceItemId,
        source_url: desired.sourceUrl,
        canonical_url: desired.canonicalUrl,
        source_gone: 0,
        last_checked_at: now(),
      });
      const after = bindingOf(updated);
      deps.repo.logAudit("item.booth_correction", "item", String(itemId), actual, after);
      deps.repo.addSnapshot(itemId, "booth", {
        jsonHash: hash(JSON.stringify(snapshotProjection(meta))),
        files: snapshotFiles(meta),
        priceText: meta.priceText,
        imageUrls: snapshotImageUrls(meta),
      });
      const item = deps.repo.getItem(itemId);
      if (!item) throw notFound(itemId);
      return { changed: true, itemId, previousBinding: actual, currentBinding: after, item };
    });
  } catch (e) {
    if (isSourceUniqueConflict(e)) {
      const owner = deps.repo.getItemBySource("booth", parsed.itemId);
      if (owner && owner.id !== itemId) throw occupied(owner);
    }
    throw e;
  }
}
