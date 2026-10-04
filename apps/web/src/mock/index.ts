/**
 * 内置 mock 后端 —— API 不可达时的回退实现。
 * 请求/响应形状严格对齐 docs/api.md；作业状态转移用 contracts.ts 的冻结转移表 resolveTransition，
 * 因此非法操作会产生真实的 409 INVALID_TRANSITION。
 */
import { MAX_ATTEMPTS, resolveTransition } from "@core/contracts";
import type {
  AppErrorCode, ArchiveEntry, AssetRow, AvatarMatch, ContainerKind, ItemCard, ItemRow,
  JobEvent, JobEventRow, JobRow, JobState, SourceSite, UnityPackageAsset,
} from "@core/contracts";
import {
  addJob, archiveEntries, assetAvatars, assets, avatars, images, itemAvatars, itemTags,
  items, jobs, nextId, projects, roots, svgCover, tags, unityPackageAssets, updates,
} from "./seed";

export class MockHttpError extends Error {
  constructor(public code: AppErrorCode, message: string, public status: number) {
    super(message);
    this.name = "MockHttpError";
  }
}
function fail(code: AppErrorCode, message: string, status = 400): never {
  throw new MockHttpError(code, message, status);
}

export function resetMock(): void { /* 种子为模块级单例；重置于测试无意义，保留接口稳定 */ }

export function mockMediaUrl(imageId: number, w?: number): string {
  const img = images.find((i) => i.id === imageId);
  const hue = (imageId * 37) % 360;
  const label = img ? "IMG #" + img.id : "IMG #" + imageId;
  const sub = img ? img.role + " · " + (w ? w + "px" : "orig") : w ? w + "px" : "orig";
  return svgCover(label, hue, sub);
}

export function mockEntry(assetId: number, entryPath: string): { contentType: string; dataUrl: string | null; text: string | null } {
  const a = assets.find((x) => x.id === assetId);
  if (!a) fail("NOT_FOUND", "资产 " + assetId + " 不存在", 404);
  const ext = entryPath.slice(entryPath.lastIndexOf(".") + 1).toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
    return { contentType: "image/svg+xml", dataUrl: svgCover(entryPath.slice(entryPath.lastIndexOf("/") + 1).slice(0, 18), (entryPath.length * 13) % 360), text: null };
  }
  const lines = [
    "# " + entryPath,
    "# asset_id=" + assetId + " container=" + a.container,
    "# mock 模式：内容为占位文本（真实模式由 /assets/:id/entry 从压缩包直读）",
    "",
    "generated_at = 2026-10-04T02:20:00Z",
    "size_bytes  = " + (a.size % 8192),
  ];
  return { contentType: "text/plain; charset=utf-8", dataUrl: null, text: lines.join("\n") };
}

// ---------- 投影 ----------
function coverUrlOf(item: ItemRow): string | null {
  return item.cover_image_id ? mockMediaUrl(item.cover_image_id, 480) : null;
}
function avatarsOfItem(itemId: number): { id: number; name: string; match: AvatarMatch; confidence: number | null; evidence: string | null; source: string | null }[] {
  return itemAvatars.filter((x) => x.item_id === itemId).map((x) => ({
    id: x.avatar_id, name: avatars.find((a) => a.id === x.avatar_id)?.name ?? "?" + x.avatar_id,
    match: x.match, confidence: x.confidence ?? null, evidence: x.evidence ?? null, source: x.source ?? null,
  }));
}
function cardOf(item: ItemRow): ItemCard {
  const imgs = images.filter((i) => i.item_id === item.id);
  const ast = assets.filter((a) => a.item_id === item.id && a.status !== "trashed");
  return {
    id: item.id, title: item.title, sourceSite: item.source_site, sourceItemId: item.source_item_id, sourceUrl: item.source_url,
    shopName: item.shop_name, status: item.status, favorite: item.favorite, adult: item.adult,
    coverImageId: item.cover_image_id, coverUrl: coverUrlOf(item), imageCount: imgs.length, assetCount: ast.length,
    totalBytes: ast.reduce((n, a) => n + a.size, 0),
    avatars: avatarsOfItem(item.id), tags: itemTags.get(item.id) ?? [], compatDeclaredCount: item.compat_declared_count,
    updatedAt: item.updated_at,
  };
}
function itemCountOf(avatarId: number): number {
  const ids = new Set(itemAvatars.filter((x) => x.avatar_id === avatarId).map((x) => x.item_id));
  return items.filter((i) => ids.has(i.id) && i.status !== "trashed").length;
}
function cardOfAvatar(a: (typeof avatars)[number]) {
  return {
    id: a.id, name: a.name, kind: a.kind, owned: a.owned,
    coverPath: svgCover(a.name, (a.id * 61) % 360, a.kind + (a.owned ? " · 所有" : " · 未所有")),
    itemCount: itemCountOf(a.id), aliases: a.aliases.map((x) => x.alias), boothItemId: a.booth_item_id,
  };
}

function detailOf(item: ItemRow) {
  const id = item.id;
  const imgs = images.filter((i) => i.item_id === id).sort((a, c) => a.position - c.position)
    .map((i) => ({ ...i, url: mockMediaUrl(i.id, 960), thumbUrl: mockMediaUrl(i.id, 240) }));
  return {
    ...cardOf(item), item, images: imgs,
    assets: assets.filter((a) => a.item_id === id && a.status !== "trashed"),
    notes: item.notes, description: item.description, updates: updates.filter((u) => u.item_id === id),
  };
}

// ---------- 查询 ----------
function num(v: string | null): number | null { if (v === null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

function listItems(q: URLSearchParams) {
  const text = (q.get("q") ?? "").trim().toLowerCase();
  const site = q.get("site") ?? "";
  const status = q.get("status") ?? "";
  const tag = q.get("tag") ?? "";
  const container = q.get("container") ?? "";
  const ownedOnly = q.get("ownedOnly") === "1" || q.get("ownedOnly") === "true";
  const avatarIds = (q.getAll("avatar").join(",") || "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  const match = (q.get("avatarMatch") ?? "any") as AvatarMatch;
  const sort = q.get("sort") ?? "updated";
  const limit = num(q.get("limit")) ?? 100;
  const offset = num(q.get("offset")) ?? 0;

  let rows = items.filter((i) => (status ? i.status === status : i.status !== "trashed"));
  if (site) rows = rows.filter((i) => i.source_site === site);
  if (tag) rows = rows.filter((i) => (itemTags.get(i.id) ?? []).includes(tag));
  if (text) {
    rows = rows.filter((i) => [i.title, i.shop_name, i.author, i.category_name, i.description, i.notes, i.source_item_id]
      .some((f) => (f ?? "").toLowerCase().includes(text)));
  }
  if (avatarIds.length) {
    const owns = (itemId: number, aid: number) => itemAvatars.some((x) => x.item_id === itemId && x.avatar_id === aid);
    rows = rows.filter((i) => (match === "all" ? avatarIds.every((a) => owns(i.id, a)) : avatarIds.some((a) => owns(i.id, a))));
  }
  if (ownedOnly) {
    const ownedIds = new Set(avatars.filter((a) => a.owned).map((a) => a.id));
    rows = rows.filter((i) => avatarsOfItem(i.id).some((a) => ownedIds.has(a.id)));
  }
  if (container) {
    rows = rows.filter((i) => assets.some((a) => a.item_id === i.id && a.container === container));
  }
  const importedQ = q.get("imported");
  if (importedQ === "1" || importedQ === "0") {
    const set = new Set(imports.map((x) => x.item_id));
    rows = rows.filter((i) => (importedQ === "1" ? set.has(i.id) : !set.has(i.id)));
  }
  if (sort === "title") rows = [...rows].sort((a, b) => a.title.localeCompare(b.title, "ja"));
  else if (sort === "size") {
    const size = (i: ItemRow) => assets.filter((a) => a.item_id === i.id).reduce((n, a) => n + a.size, 0);
    rows = [...rows].sort((a, b) => size(b) - size(a));
  } else rows = [...rows].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));

  const total = rows.length;
  return { total, items: rows.slice(offset, offset + limit).map(cardOf) };
}

// ---------- 作业 ----------
const NEXT_EVENT: Partial<Record<JobState, JobEvent>> = {
  queued: "start", resolving: "resolve_ok", fetching: "fetch_ok", materializing: "commit",
  indexing: "index_ok", matching: "match_ok", releasing_done: "succeed",
};
const intents = new Map<number, "pause" | "cancel">();
const imports: { project_id: number; item_id: number; asset_id: number | null; created_at: string }[] = [];

function applyEvent(entry: { job: JobRow; events: JobEventRow[] }, event: JobEvent): void {
  const to = resolveTransition(entry.job.state, event, { attempts: entry.job.attempts });
  if (to === null) {
    throw new MockHttpError("INVALID_TRANSITION",
      "作业 #" + entry.job.id + "（" + entry.job.state + "）不支持事件 " + event + "：状态机无此转移", 409);
  }
  const from = entry.job.state;
  entry.job.state = to;
  entry.job.started_at = entry.job.started_at ?? new Date().toISOString();
  if (to === "done" || to === "cancelled" || to === "abandoned" || to === "failed") entry.job.finished_at = new Date().toISOString();
  entry.events.push({ id: nextId(), job_id: entry.job.id, at: new Date().toISOString(), from_state: from, to_state: to, event, detail: null });
}

/** 模拟 worker：每轮 GET /jobs 推进一步（冻结的演示作业不走）。 */
function tick(): void {
  for (const entry of jobs) {
    if (entry.frozen) continue;
    const st = entry.job.state;
    if (st === "done" || st === "cancelled" || st === "abandoned" || st === "failed" || st === "paused") continue;
    if (st === "releasing") {
      const intent = intents.get(entry.job.id);
      intents.delete(entry.job.id);
      if (intent === "cancel") { applyEvent(entry, "cancel_apply"); continue; }
      if (intent === "pause") { applyEvent(entry, "hold"); continue; }
      if (entry.job.error) applyEvent(entry, "fail");
      else applyEvent(entry, "give_up");
      continue;
    }
    const ev = NEXT_EVENT[st];
    if (!ev) continue;
    if (entry.job.error && st === "indexing") { applyEvent(entry, "stop"); continue; }
    applyEvent(entry, ev);
  }
}

const ACTION_EVENT: Record<string, JobEvent> = { pause: "stop", resume: "resume", cancel: "stop", retry: "retry", abandon: "abandon", giveUp: "give_up" };

function jobAction(id: number, action: string): JobRow {
  const entry = jobs.find((j) => j.job.id === id);
  if (!entry) fail("NOT_FOUND", "作业 #" + id + " 不存在", 404);
  const st = entry.job.state;
  let event = ACTION_EVENT[action];
  if (!event) fail("INVALID_INPUT", "未知作业动作 " + action);
  if (action === "cancel" && st === "releasing") event = "cancel_apply";
  if (action === "pause" && st === "releasing") event = "hold";
  if (action === "abandon" && st === "releasing") event = "give_up";
  if ((action === "pause" || action === "cancel") && ["queued", "resolving", "fetching", "materializing", "indexing", "matching"].includes(st)) {
    intents.set(id, action === "pause" ? "pause" : "cancel");
  }
  const before = entry.job.attempts;
  applyEvent(entry, event);
  if (action === "retry" && entry.job.state === "queued") entry.job.attempts = before + 1;
  return entry.job;
}

// ---------- BOOTH ----------
function peek(url: string) {
  const m = /booth\.pm\/(?:[a-z]{2}\/)?(?:items\/)?(\d+)/i.exec(url) ?? /items\/(\d+)/i.exec(url);
  const itemId = m ? m[1] : null;
  if (!itemId) fail("INVALID_INPUT", "不是可识别的 BOOTH 商品链接：" + url);
  const existing = items.find((i) => i.source_item_id === itemId);
  const title = existing ? existing.title : "BOOTH item " + itemId + "（mock 预览）";
  const imgs = existing ? images.filter((i) => i.item_id === existing.id) : [];
  return {
    itemId, title,
    description: existing?.description ?? "mock 模式：未联网抓取，内容为占位。",
    priceText: existing?.price_text ?? "¥1,000", priceYen: existing?.price_yen ?? 1000,
    publishedAt: existing?.published_at ?? "2025-12-01T00:00:00.000Z", isAdult: (existing?.adult ?? 0) === 1,
    url: "https://booth.pm/ja/items/" + itemId,
    shop: { name: existing?.shop_name ?? "mock shop", subdomain: existing?.shop_subdomain ?? "mock-shop" },
    tags: (itemTags.get(existing?.id ?? -1) ?? []).map((n) => ({ name: n })),
    category: { name: existing?.category_name ?? "衣装", parent: existing?.category_parent ? { name: existing.category_parent } : null },
    images: imgs.length ? imgs.map((i) => ({ original: mockMediaUrl(i.id, 720), resized: mockMediaUrl(i.id, 480) })) : [{ original: svgCover("BOOTH " + itemId, 205), resized: svgCover("BOOTH " + itemId, 205, "resized") }],
    variations: [{ id: 1, price: existing?.price_yen ?? 1000, name: "通常版", files: [{ name: "pkg.zip", file_name: "pkg.zip", file_extension: "zip", file_size: "12.4 MB", url: "https://booth.pm/downloadables/1?variation_id=1" }] }],
    inLibrary: existing ? { itemId: existing.id, title: existing.title } : null,
  };
}

// ---------- 路由 ----------
export interface MockResponse { status: number; body: unknown }

export function mockHandle(method: string, rawPath: string, query: URLSearchParams, body: unknown): MockResponse {
  const path = rawPath.replace(/^\/api/, "");
  const seg = path.split("/").filter(Boolean);
  const b = (body ?? {}) as Record<string, unknown>;
  const M = method.toUpperCase();
  const now = new Date().toISOString();

  if (seg[0] === "health" && M === "GET") {
    return { status: 200, body: { ok: true, version: "0.1.0-mock", dbPath: "<repo>/data/mock.db", roots, counts: { items: items.length, assets: assets.length, images: images.length, avatars: avatars.length, jobs: jobs.length } } };
  }

  if (seg[0] === "items") {
    if (seg.length === 1 && M === "GET") return { status: 200, body: listItems(query) };
    if (seg.length === 1 && M === "POST") {
      const title = String(b.title ?? "").trim();
      if (!title) fail("INVALID_INPUT", "title 不能为空");
      const id = Math.max(0, ...items.map((i) => i.id)) + 1;
      const row: ItemRow = {
        id, uid: "manual-" + id, source_site: "local", source_item_id: null, source_url: null, canonical_url: null,
        title, title_ja: null, shop_name: null, shop_subdomain: null, author: null, price_text: null, price_yen: null,
        purchased: 0, purchased_at: null, published_at: null, category_name: null, category_parent: null,
        description: null, adult: 0, status: "inbox", rating: null, favorite: 0, notes: String(b.notes ?? "") || null,
        cover_image_id: null, compat_declared_count: null, id_confidence: null, id_match_method: "manual",
        source_gone: 0, last_checked_at: null, created_at: now, updated_at: now,
      };
      items.push(row); itemTags.set(id, []);
      return { status: 201, body: cardOf(row) };
    }
    const id = Number(seg[1]);
    const item = items.find((i) => i.id === id);
    if (!item) fail("NOT_FOUND", "条目 " + seg[1] + " 不存在", 404);

    if (seg.length === 2 && M === "GET") return { status: 200, body: detailOf(item) };
    if (seg.length === 2 && M === "PATCH") {
      const allowed: [string, keyof ItemRow][] = [["title", "title"], ["status", "status"], ["notes", "notes"], ["rating", "rating"], ["favorite", "favorite"], ["shopName", "shop_name"], ["author", "author"], ["categoryName", "category_name"]];
      for (const [k, col] of allowed) if (k in b) (item as unknown as Record<string, unknown>)[col] = b[k];
      if (Array.isArray(b.tags)) itemTags.set(id, (b.tags as unknown[]).map(String));
      item.updated_at = now;
      return { status: 200, body: cardOf(item) };
    }
    if (seg.length === 2 && M === "DELETE") { item.status = "trashed"; item.updated_at = now; return { status: 200, body: { ok: true, status: "trashed" } }; }
    if (seg.length === 3 && seg[2] === "restore" && M === "POST") { item.status = "inbox"; item.updated_at = now; return { status: 200, body: cardOf(item) }; }
    if (seg.length === 3 && seg[2] === "images" && M === "POST") {
      const paths = Array.isArray(b.paths) ? (b.paths as unknown[]).map(String) : [];
      const url = typeof b.url === "string" && b.url ? b.url : null;
      if (!paths.length && !url) fail("INVALID_INPUT", "images 需要 paths[] 或 url 之一");
      const created: unknown[] = [];
      const srcs: { file: string | null; url: string | null }[] = paths.length ? paths.map((p) => ({ file: p, url: null })) : [{ file: null, url }];
      for (const s of srcs) {
        const iid = nextId();
        const img = {
          id: iid, item_id: id, role: (typeof b.role === "string" ? b.role : "user") as "user", origin: (s.url ? "user" : "user") as "user",
          source_url: s.url, file_path: s.file, thumb_path: null, width: 480, height: 640, bytes: 90000,
          sha256: "usr" + String(iid).padStart(61, "0"), position: images.filter((i) => i.item_id === id).length, created_at: now,
        };
        images.push(img as unknown as (typeof images)[number]);
        created.push({ ...img, url: mockMediaUrl(iid, 960), thumbUrl: mockMediaUrl(iid, 240) });
      }
      item.updated_at = now;
      return { status: 201, body: { images: created } };
    }
    if (seg.length === 4 && seg[2] === "images" && M === "DELETE") {
      const iid = Number(seg[3]);
      const idx = images.findIndex((i) => i.id === iid && i.item_id === id);
      if (idx < 0) fail("NOT_FOUND", "图片 " + seg[3] + " 不存在", 404);
      images.splice(idx, 1);
      if (item.cover_image_id === iid) item.cover_image_id = images.find((i) => i.item_id === id)?.id ?? null;
      return { status: 200, body: { ok: true } };
    }
    if (seg.length === 4 && seg[2] === "images" && seg[3] === "reorder" && M === "POST") {
      const ids = Array.isArray(b.imageIds) ? (b.imageIds as unknown[]).map(Number) : [];
      if (!ids.length) fail("INVALID_INPUT", "imageIds 不能为空");
      for (const im of images.filter((i) => i.item_id === id)) {
        const at = ids.indexOf(im.id);
        if (at >= 0) im.position = at;
      }
      item.updated_at = now;
      return { status: 200, body: detailOf(item) };
    }
    if (seg.length === 3 && seg[2] === "tags" && M === "POST") {
      const add = Array.isArray(b.tags) ? (b.tags as unknown[]).map(String).filter(Boolean) : [];
      if (!add.length) fail("INVALID_INPUT", "tags 不能为空");
      itemTags.set(id, [...new Set([...(itemTags.get(id) ?? []), ...add])]);
      item.updated_at = now;
      return { status: 200, body: detailOf(item) };
    }
    if (seg.length === 4 && seg[2] === "tags" && M === "DELETE") {
      const key = decodeURIComponent(seg[3]);
      const cur = itemTags.get(id) ?? [];
      const byName = cur.filter((t) => t !== key);
      if (byName.length !== cur.length) { itemTags.set(id, byName); return { status: 200, body: detailOf(item) }; }
      const idx = Number(key);
      if (Number.isInteger(idx) && idx >= 0 && idx < cur.length) {
        const next = [...cur]; next.splice(idx, 1); itemTags.set(id, next);
        return { status: 200, body: detailOf(item) };
      }
      fail("NOT_FOUND", "标签 " + key + " 不在条目 #" + id + " 上（mock 支持按名或下标删除）", 404);
    }
    if (seg.length === 5 && seg[2] === "images" && seg[4] === "cover" && M === "POST") {
      const iid = Number(seg[3]);
      if (!images.some((i) => i.id === iid && i.item_id === id)) fail("NOT_FOUND", "图片 " + seg[3] + " 不存在", 404);
      item.cover_image_id = iid;
      item.updated_at = now;
      return { status: 200, body: cardOf(item) };
    }
    if (seg.length === 3 && seg[2] === "assets" && M === "POST") {
      const p = String(b.path ?? "");
      if (!p) fail("INVALID_INPUT", "path 不能为空");
      const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
      const container: ContainerKind = ext === "zip" ? "zip" : ext === "7z" ? "7z" : ext === "rar" ? "rar" : ext === "unitypackage" ? "unitypackage" : p.endsWith("/") ? "dir" : "file";
      const aid = nextId();
      const row: AssetRow = {
        id: aid, item_id: id, kind: container === "zip" || container === "7z" || container === "rar" ? "archive" : container === "unitypackage" ? "unitypackage" : container === "dir" ? "folder" : "loose_file",
        container, path: p, path_norm: p.toLowerCase(), root_id: 1, size: 3_000_000, mtime: now, sha256: null, sha256_state: "pending",
        status: "present", discovered_by: "manual", first_seen: now, last_verified_at: null,
      };
      assets.push(row);
      if (container === "unitypackage") unityPackageAssets.set(aid, unityPackageAssets.get(assets[0]?.id ?? 0) ?? []);
      if (container === "zip" || container === "7z" || container === "dir") {
        archiveEntries.set(aid, (archiveEntries.get(assets.find((a) => a.container === container)?.id ?? 0) ?? []).map((e) => ({ ...e })));
      }
      item.updated_at = now;
      return { status: 201, body: row };
    }
    if (seg.length === 3 && seg[2] === "avatars" && M === "POST") {
      const ids = Array.isArray(b.avatarIds) ? (b.avatarIds as unknown[]).map(Number) : [];
      if (!ids.length) fail("INVALID_INPUT", "avatarIds 不能为空");
      for (const aidV of ids) {
        if (!avatars.some((a) => a.id === aidV)) fail("NOT_FOUND", "头像 " + aidV + " 不存在", 404);
        if (itemAvatars.some((x) => x.item_id === id && x.avatar_id === aidV)) continue;
        itemAvatars.push({ item_id: id, avatar_id: aidV, match: (b.match as AvatarMatch) ?? "any", confidence: 1, evidence: "manual:UI 手工标注", source: "manual" });
      }
      item.updated_at = now;
      return { status: 200, body: avatarsOfItem(id) };
    }
    if (seg.length === 4 && seg[2] === "avatars" && M === "DELETE") {
      const aidV = Number(seg[3]);
      const idx = itemAvatars.findIndex((x) => x.item_id === id && x.avatar_id === aidV);
      if (idx < 0) fail("NOT_FOUND", "该条目未标注头像 " + seg[3], 404);
      itemAvatars.splice(idx, 1);
      return { status: 200, body: avatarsOfItem(id) };
    }
    if (seg.length === 3 && (seg[2] === "check-update" || seg[2] === "match-avatars") && M === "POST") {
      const job = addJob(seg[2] === "check-update" ? "check_update" : "match_avatars", id, JSON.stringify({ itemId: id }));
      return { status: 202, body: { jobId: job.id } };
    }
  }

  if (seg[0] === "avatars") {
    if (seg.length === 1 && M === "GET") {
      const text = (query.get("q") ?? "").trim().toLowerCase();
      const ownedOnly = query.get("ownedOnly") === "1" || query.get("ownedOnly") === "true";
      let rows = avatars;
      if (ownedOnly) rows = rows.filter((a) => a.owned);
      if (text) rows = rows.filter((a) => a.name.toLowerCase().includes(text) || a.aliases.some((x) => x.alias.toLowerCase().includes(text)));
      return { status: 200, body: { avatars: [...rows].sort((a, c) => a.sort - c.sort).map(cardOfAvatar) } };
    }
    if (seg.length === 1 && M === "POST") {
      const name = String(b.name ?? "").trim();
      if (!name) fail("INVALID_INPUT", "name 不能为空");
      if (avatars.some((a) => a.name_norm === name.toLowerCase())) fail("CONFLICT", "头像已存在：" + name, 409);
      const id = Math.max(0, ...avatars.map((a) => a.id)) + 1;
      const row = { id, name, name_norm: name.toLowerCase(), kind: (b.kind as "avatar") ?? "avatar", booth_item_id: (b.boothItemId as string) ?? null, cover_path: null, owned: b.owned ? 1 : 0, sort: id, created_at: now, updated_at: now, aliases: (Array.isArray(b.aliases) ? (b.aliases as unknown[]).map(String) : []).map((a, i) => ({ id: nextId(), alias: a, lang: null, source: "user" })) };
      avatars.push(row as unknown as (typeof avatars)[number]);
      return { status: 201, body: cardOfAvatar(row as unknown as (typeof avatars)[number]) };
    }
    if (seg.length === 2 && M === "GET") {
      const aid = Number(seg[1]);
      if (!avatars.some((a) => a.id === aid)) fail("NOT_FOUND", "头像 " + seg[1] + " 不存在", 404);
      const ids = new Set(itemAvatars.filter((x) => x.avatar_id === aid).map((x) => x.item_id));
      const q2 = new URLSearchParams(query);
      const all = listItems(q2);
      return { status: 200, body: { ...all, items: all.items.filter((c) => ids.has(c.id)) } };
    }
    if (seg.length === 2 && M === "PATCH") {
      const a = avatars.find((x) => x.id === Number(seg[1]));
      if (!a) fail("NOT_FOUND", "头像 " + seg[1] + " 不存在", 404);
      if (typeof b.name === "string") { a.name = b.name; a.name_norm = b.name.toLowerCase(); }
      if (typeof b.kind === "string") a.kind = b.kind as "avatar";
      if (typeof b.owned === "boolean" || typeof b.owned === "number") a.owned = b.owned ? 1 : 0;
      if (typeof b.coverPath === "string") a.cover_path = b.coverPath;
      if (typeof b.boothItemId === "string") a.booth_item_id = b.boothItemId;
      a.updated_at = now;
      return { status: 200, body: cardOfAvatar(a) };
    }
    if (seg.length === 3 && seg[2] === "aliases" && M === "POST") {
      const a = avatars.find((x) => x.id === Number(seg[1]));
      if (!a) fail("NOT_FOUND", "头像 " + seg[1] + " 不存在", 404);
      const alias = String(b.alias ?? "").trim();
      if (!alias) fail("INVALID_INPUT", "alias 不能为空");
      const owner = avatars.find((x) => x.aliases.some((y) => y.alias.toLowerCase() === alias.toLowerCase()));
      if (owner && owner.id !== a.id) fail("CONFLICT", "别名「" + alias + "」已被 " + owner.name + " 占用（进待确认，不静默合并）", 409);
      if (a.aliases.some((y) => y.alias.toLowerCase() === alias.toLowerCase())) fail("CONFLICT", "该别名已存在", 409);
      const row = { id: nextId(), alias, lang: (b.lang as string) ?? null, source: (b.source as string) ?? "user" };
      a.aliases.push(row);
      return { status: 201, body: { alias: { id: row.id, avatar_id: a.id, alias, alias_norm: alias.toLowerCase(), lang: row.lang, source: row.source }, pendingConfirm: false, conflictWith: null } };
    }
    if (seg.length === 4 && seg[2] === "aliases" && M === "DELETE") {
      const a = avatars.find((x) => x.id === Number(seg[1]));
      if (!a) fail("NOT_FOUND", "头像 " + seg[1] + " 不存在", 404);
      const i = a.aliases.findIndex((x) => x.id === Number(seg[3]));
      if (i < 0) fail("NOT_FOUND", "别名不存在", 404);
      a.aliases.splice(i, 1);
      return { status: 200, body: { ok: true } };
    }
    if (seg.length === 2 && seg[1] === "merge" && M === "POST") fail("INVALID_INPUT", "POST /avatars/merge 需在 body 提供 fromId/intoId（本 mock 未实现迁移）");
  }

  if (seg[0] === "assets") {
    const aid = Number(seg[1]);
    const asset = assets.find((a) => a.id === aid);
    if (!asset) fail("NOT_FOUND", "资产 " + seg[1] + " 不存在", 404);
    if (seg.length === 2 && M === "GET") return { status: 200, body: { ...asset, avatars: assetAvatars.filter((x) => x.asset_id === aid) } };
    if (seg.length === 3 && seg[2] === "tree" && M === "GET") {
      if (asset.container === "unitypackage") return { status: 200, body: { container: asset.container, entries: [] as ArchiveEntry[], truncated: false, note: "unitypackage 请用 /assets/:id/unitypackage" } };
      if (asset.container === "file" || asset.container === "dir") return { status: 200, body: { container: asset.container, entries: archiveEntries.get(aid) ?? [], truncated: false, passwordProtected: false } };
      return { status: 200, body: { container: asset.container, entries: archiveEntries.get(aid) ?? [], truncated: false, passwordProtected: false, note: "mock 缓存目录列表" } };
    }
    if (seg.length === 3 && seg[2] === "unitypackage" && M === "GET") {
      if (asset.container !== "unitypackage") fail("NOT_AN_ARCHIVE", "资产不是 .unitypackage：" + asset.path, 400);
      const list: UnityPackageAsset[] = unityPackageAssets.get(aid) ?? [];
      return { status: 200, body: { assets: list, truncated: false } };
    }
    if (seg.length === 3 && seg[2] === "entry" && M === "GET") {
      const p = query.get("path") ?? "";
      if (!p) fail("INVALID_INPUT", "path 查询参数必填");
      return { status: 200, body: mockEntry(aid, p) };
    }
    if (seg.length === 3 && seg[2] === "reindex" && M === "POST") return { status: 202, body: { jobId: addJob("reindex", asset.item_id, JSON.stringify({ assetId: aid })).id } };
  }

  if (seg[0] === "booth" && seg[1] === "peek" && M === "GET") return { status: 200, body: peek(query.get("url") ?? "") };

  if (seg[0] === "import" && M === "POST") {
    if (seg[1] === "url") {
      const url = String(b.url ?? "");
      if (!url) fail("INVALID_INPUT", "url 不能为空");
      const meta = peek(url);
      let item = items.find((i) => i.source_item_id === meta.itemId);
      if (!item) {
        const id = Math.max(0, ...items.map((i) => i.id)) + 1;
        item = { id, uid: "booth-" + meta.itemId, source_site: "booth", source_item_id: meta.itemId, source_url: meta.url, canonical_url: meta.url, title: meta.title, title_ja: null, shop_name: meta.shop.name, shop_subdomain: meta.shop.subdomain, author: null, price_text: meta.priceText, price_yen: meta.priceYen, purchased: 0, purchased_at: null, published_at: meta.publishedAt, category_name: meta.category.name, category_parent: meta.category.parent?.name ?? null, description: meta.description, adult: meta.isAdult ? 1 : 0, status: "inbox", rating: null, favorite: 0, notes: null, cover_image_id: null, compat_declared_count: null, id_confidence: 0.99, id_match_method: "url", source_gone: 0, last_checked_at: null, created_at: now, updated_at: now };
        items.push(item); itemTags.set(id, []);
      }
      const job = addJob("import_url", item.id, JSON.stringify({ url, downloadImages: b.downloadImages !== false }));
      return { status: 202, body: { jobId: job.id, itemId: item.id } };
    }
    if (seg[1] === "paths") {
      const paths = Array.isArray(b.paths) ? (b.paths as unknown[]).map(String) : [];
      if (!paths.length) fail("INVALID_INPUT", "paths 不能为空");
      return { status: 202, body: { jobId: addJob("import_file", null, JSON.stringify({ paths })).id } };
    }
  }
  if (seg[0] === "scan" && M === "POST") {
    const payload = { rootId: b.rootId ?? null, path: b.path ?? null, deep: b.deep === true };
    if (b.dryRun === true) {
      const plans = items.slice(0, 4).map((i) => ({
        title: i.title, sourceSite: i.source_site, sourceItemId: i.source_item_id,
        confidence: i.id_confidence, assets: assets.filter((a) => a.item_id === i.id).length,
      }));
      return { status: 200, body: { dryRun: true, rootId: payload.rootId, path: payload.path, deep: payload.deep, items: plans } };
    }
    return { status: 202, body: { jobId: addJob("scan", null, JSON.stringify(payload)).id } };
  }

  if (seg[0] === "jobs") {
    if (seg.length === 1 && M === "GET") {
      tick();
      const state = query.get("state");
      const limit = num(query.get("limit")) ?? 50;
      let rows = jobs.map((j) => j.job);
      if (state) rows = rows.filter((j) => j.state === state);
      rows = [...rows].sort((a, c) => c.id - a.id).slice(0, limit);
      return { status: 200, body: { jobs: rows } };
    }
    const jid = Number(seg[1]);
    const entry = jobs.find((j) => j.job.id === jid);
    if (!entry) fail("NOT_FOUND", "作业 " + seg[1] + " 不存在", 404);
    if (seg.length === 3 && seg[2] === "events" && M === "GET") return { status: 200, body: entry.events };
    if (seg.length === 3 && M === "POST" && ["pause", "resume", "cancel", "retry", "abandon"].includes(seg[2])) {
      return { status: 200, body: { job: jobAction(jid, seg[2]) } };
    }
  }

  if (seg[0] === "roots") {
    if (M === "GET") return { status: 200, body: { roots } };
    if (M === "POST") {
      const p = String(b.path ?? "");
      if (!p) fail("INVALID_INPUT", "path 不能为空");
      const row = { id: Math.max(0, ...roots.map((r) => r.id)) + 1, path: p, path_norm: p.toLowerCase(), mode: ((b.mode as string) ?? "index_in_place") as "index_in_place", enabled: 1, created_at: now };
      roots.push(row as unknown as (typeof roots)[number]);
      return { status: 201, body: row };
    }
    if (seg.length === 2 && M === "DELETE") {
      const i = roots.findIndex((r) => r.id === Number(seg[1]));
      if (i < 0) fail("NOT_FOUND", "根目录不存在", 404);
      roots.splice(i, 1);
      return { status: 200, body: { ok: true } };
    }
  }
  if (seg[0] === "tags") {
    if (M === "GET") return { status: 200, body: { tags } };
    if (M === "POST") {
      const name = String(b.name ?? "").trim();
      if (!name) fail("INVALID_INPUT", "name 不能为空");
      if (tags.some((t) => t.name === name)) fail("CONFLICT", "标签已存在：" + name, 409);
      const row = { id: Math.max(0, ...tags.map((t) => t.id)) + 1, name, namespace: (b.namespace as string) ?? null, color: (b.color as string) ?? null, sort: tags.length + 1 };
      tags.push(row);
      return { status: 201, body: row };
    }
  }
  if (seg[0] === "projects") {
    if (M === "GET") return { status: 200, body: { projects } };
    if (seg.length === 1 && M === "POST") {
      const name = String(b.name ?? "").trim();
      if (!name) fail("INVALID_INPUT", "name 不能为空");
      const row = { id: Math.max(0, ...projects.map((p) => p.id)) + 1, name, path: String(b.path ?? ""), created_at: now };
      projects.push(row);
      return { status: 201, body: row };
    }
    if (seg.length === 3 && seg[2] === "imports" && M === "POST") {
      const pid = Number(seg[1]);
      if (!projects.some((p) => p.id === pid)) fail("NOT_FOUND", "工程 " + seg[1] + " 不存在", 404);
      const iid = Number(b.itemId);
      if (!items.some((i) => i.id === iid)) fail("NOT_FOUND", "条目 " + b.itemId + " 不存在", 404);
      imports.push({ project_id: pid, item_id: iid, asset_id: b.assetId === undefined ? null : Number(b.assetId), created_at: now });
      return { status: 201, body: imports[imports.length - 1] };
    }
  }
  if (seg[0] === "stats" && M === "GET") {
    const byCategory = new Map<string, number>();
    for (const i of items) { const k = i.category_name ?? "(未分类)"; byCategory.set(k, (byCategory.get(k) ?? 0) + 1); }
    const byAvatar = avatars.map((a) => ({ id: a.id, name: a.name, count: itemCountOf(a.id) }));
    return { status: 200, body: { items: items.length, assets: assets.length, bytes: assets.reduce((n, a) => n + a.size, 0), avatars: avatars.length, byCategory: [...byCategory].map(([name, count]) => ({ name, count })), byAvatar } };
  }
  if (seg[0] === "export" && M === "GET") return { status: 200, body: { exportedAt: now, items: items.map(cardOf) } };

  fail("NOT_FOUND", "mock 未实现的路由：" + M + " " + path, 404);
}
