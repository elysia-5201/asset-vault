/**
 * BOOTH 更正 HTTP（task-70；frozen-interface-B1.md）。
 *
 * 真实 root registerRoutes + Fastify.inject + 真实临时 SQLite；只闭合 booth.fetchItem，不联网。
 * 覆盖：root 可达、preview/confirm DTO、400/404/409 details、占用含 trashed、成功全保留、noop。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { openTempDb, addItem, addRoot, addAsset, addImage, addAvatar, count, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerRoutes } from "../../apps/server/src/http/routes";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";
import type { BoothItemMeta } from "../../packages/core/src/contracts";

const OLD = "1234567";
const TARGET = "7654321";
const OLD_URL = "https://booth.pm/ja/items/" + OLD;
const TARGET_URL = "https://booth.pm/ja/items/" + TARGET;

function meta(over: Partial<BoothItemMeta> = {}): BoothItemMeta {
  return {
    itemId: TARGET, title: "新商品", description: "新描述", priceText: "¥1,000", priceYen: 1000,
    publishedAt: "2026-01-02T03:04:05.000Z", isAdult: false, url: TARGET_URL,
    shop: { name: "店", subdomain: "shop" }, tags: [{ name: "tag1" }, { name: "tag2" }],
    category: { id: 1, name: "衣装", parent: { name: "服" } },
    images: [{ original: "https://img.test/1.png" }, { original: "https://img.test/2.png" }],
    variations: [{ id: 1, price: 1000, files: [
      { name: "a.zip", file_size: "10", url: "https://dl.test/a" },
      { name: "b.zip", file_size: "20", url: "https://dl.test/b" },
    ] }],
    ...over,
  };
}

function setup(t: TempDb, booth: any) {
  const repo = new Repo(t.db);
  const app = Fastify({ logger: false });
  registerRoutes(app as any, {
    repo, media: {} as any, booth, runner: {} as any, log: () => {},
    version: "test", dbPath: t.file, dataDir: t.dir, pipeline: null, limits: resolveLimits({}),
  } as any);
  return { repo, app };
}

const json = (r: { body: string }): any => JSON.parse(r.body);
const errorOf = (b: any): any => b.error ?? {};
const detailsOf = (b: any): any => errorOf(b).details ?? {};

function post(app: any, itemId: number | string, action: "preview" | "confirm", payload: any) {
  return app.inject({ method: "POST", url: "/api/items/" + itemId + "/booth-correction/" + action, payload });
}

function addBoothItem(t: TempDb, over: Record<string, unknown> = {}): number {
  return addItem(t.db, {
    title: "旧标题", source_site: "booth", source_item_id: OLD,
    source_url: OLD_URL, canonical_url: OLD_URL, ...over,
  });
}

function row(t: TempDb, id: number): any {
  return t.db.prepare("SELECT * FROM items WHERE id=?").get(id);
}

function binding(r: any) {
  return {
    sourceSite: r.source_site ?? null, sourceItemId: r.source_item_id ?? null,
    sourceUrl: r.source_url ?? null, canonicalUrl: r.canonical_url ?? null,
    sourceGone: Boolean(r.source_gone),
  };
}

function snapshot(db: any) {
  return {
    items: db.prepare("SELECT * FROM items ORDER BY id").all(),
    assets: db.prepare("SELECT * FROM assets ORDER BY id").all(),
    images: db.prepare("SELECT * FROM item_images ORDER BY id").all(),
    tags: db.prepare("SELECT * FROM item_tags ORDER BY item_id, tag_id").all(),
    avatars: db.prepare("SELECT * FROM item_avatars ORDER BY item_id, avatar_id").all(),
    snapshots: db.prepare("SELECT * FROM source_snapshots ORDER BY id").all(),
    audit: db.prepare("SELECT * FROM audit_log ORDER BY id").all(),
  };
}

function confirmBody(over: Record<string, unknown> = {}) {
  return {
    url: TARGET_URL, expectedSourceSite: "booth", expectedSourceItemId: OLD,
    expectedSourceUrl: OLD_URL, expectedTargetItemId: TARGET, confirm: true, ...over,
  };
}

function assertPreserved(before: any, after: any) {
  const source = new Set(["source_site", "source_item_id", "source_url", "canonical_url", "source_gone", "last_checked_at", "updated_at"]);
  for (const k of Object.keys(before)) if (!source.has(k)) assert.deepEqual(after[k], before[k], k);
}

function richItem(t: TempDb, repo: Repo): number {
  const root = addRoot(t.db, "/lib");
  const item = addItem(t.db, {
    title: "人工标题", title_ja: "手動タイトル", shop_name: "人工店", shop_subdomain: "manual",
    author: "作者", price_text: "¥9,999", price_yen: 9999, purchased: 1, purchased_at: "2025-01-01T00:00:00.000Z",
    published_at: "2025-02-02T00:00:00.000Z", category_name: "人工分类", category_parent: "父类",
    description: "人工描述", adult: 1, status: "archived", rating: 5, favorite: 1, notes: "人工备注",
    compat_declared_count: 3, id_confidence: 0.9, id_match_method: "manual",
    cat_id: "c1", cat_sub_id: "c1s", cat_source: "manual", cat_confidence: 1,
    cat_reason: "人工", cat_evidence: "[]", cat_assigned_at: "2025-03-03T00:00:00.000Z",
    cat_suggest_id: "c2", cat_suggest_sub_id: "c2s", cat_suggest_confidence: 0.5,
    cat_suggest_reason: "建议", cat_suggest_evidence: "[]", cat_suggest_at: "2025-04-04T00:00:00.000Z",
    source_site: "booth", source_item_id: OLD, source_url: OLD_URL, canonical_url: OLD_URL,
  });
  addAsset(t.db, item, root, "/lib/a.zip");
  addImage(t.db, item, { role: "cover", origin: "user", file_path: "/lib/cover.png" });
  const avatar = addAvatar(t.db, "A");
  repo.setItemTags(item, ["keep"], "manual");
  repo.setItemAvatars(item, [avatar], "manual", "any", 1);
  return item;
}

test("root 注册可达：preview 200 DTO，业务 DB 零写", async () => {
  const t = openTempDb();
  try {
    const { app } = setup(t, { fetchItem: async () => meta() });
    const item = addBoothItem(t);
    const before = snapshot(t.db);
    const res = await post(app, item, "preview", { url: TARGET_URL });
    assert.equal(res.statusCode, 200);
    const body = json(res);
    assert.equal(body.itemId, item);
    assert.deepEqual(body.current, { sourceSite: "booth", sourceItemId: OLD, sourceUrl: OLD_URL, canonicalUrl: OLD_URL, sourceGone: false });
    assert.deepEqual(body.target, {
      itemId: TARGET, url: TARGET_URL, canonicalUrl: TARGET_URL, title: "新商品",
      shop: { name: "店", subdomain: "shop" }, priceText: "¥1,000", priceYen: 1000,
      publishedAt: "2026-01-02T03:04:05.000Z", isAdult: false,
      category: { name: "衣装", parent: "服" }, tags: ["tag1", "tag2"], imageCount: 2, fileCount: 2,
    });
    assert.equal(body.conflict, null);
    assert.ok(body.willChange.includes("source_snapshot"));
    assert.ok(body.willChange.includes("audit"));
    assert.ok(body.willPreserve.includes("title"));
    assert.deepEqual(snapshot(t.db), before);
    await app.close();
  } finally { t.close(); }
});

test("confirm 200：只改来源身份，非 source 资料/资产/标签/图/头像全保留，audit+snapshot 同事务", async () => {
  const t = openTempDb();
  try {
    const { app, repo } = setup(t, { fetchItem: async () => meta() });
    const item = richItem(t, repo);
    const beforeRow = row(t, item);
    const beforeTables = snapshot(t.db);
    const res = await post(app, item, "confirm", confirmBody());
    assert.equal(res.statusCode, 200);
    const body = json(res);
    assert.equal(body.changed, true);
    assert.equal(body.itemId, item);
    assert.deepEqual(body.previousBinding, binding(beforeRow));
    const afterRow = row(t, item);
    assert.equal(afterRow.source_site, "booth");
    assert.equal(afterRow.source_item_id, TARGET);
    assert.equal(afterRow.source_url, TARGET_URL);
    assert.equal(afterRow.canonical_url, TARGET_URL);
    assert.equal(afterRow.source_gone, 0);
    assert.equal(typeof afterRow.last_checked_at, "string");
    assert.ok(afterRow.last_checked_at);
    assert.notEqual(afterRow.updated_at, beforeRow.updated_at);
    assertPreserved(beforeRow, afterRow);
    assert.deepEqual({
      assets: t.db.prepare("SELECT * FROM assets ORDER BY id").all(),
      images: t.db.prepare("SELECT * FROM item_images ORDER BY id").all(),
      tags: t.db.prepare("SELECT * FROM item_tags ORDER BY item_id, tag_id").all(),
      avatars: t.db.prepare("SELECT * FROM item_avatars ORDER BY item_id, avatar_id").all(),
    }, {
      assets: beforeTables.assets, images: beforeTables.images, tags: beforeTables.tags, avatars: beforeTables.avatars,
    });
    assert.equal(body.item.item.source_item_id, TARGET);
    assert.equal(body.item.images.length, 1);
    assert.equal(body.item.assets.length, 1);
    assert.deepEqual(body.item.tags, ["keep"]);
    assert.equal(body.item.avatars.length, 1);
    const audit = t.db.prepare("SELECT * FROM audit_log WHERE action='item.booth_correction'").get() as any;
    assert.ok(audit);
    assert.equal(audit.actor, "user");
    assert.equal(audit.entity, "item");
    assert.equal(audit.entity_id, String(item));
    assert.deepEqual(JSON.parse(audit.before_json), binding(beforeRow));
    assert.deepEqual(JSON.parse(audit.after_json), binding(afterRow));
    const snap = t.db.prepare("SELECT * FROM source_snapshots WHERE item_id=?").get(item) as any;
    assert.ok(snap);
    assert.equal(snap.provider, "booth");
    assert.equal(snap.price_text, "¥1,000");
    assert.deepEqual(JSON.parse(snap.files_json), [{ name: "a.zip", size: "10" }, { name: "b.zip", size: "20" }]);
    assert.deepEqual(JSON.parse(snap.image_urls_json), ["https://img.test/1.png", "https://img.test/2.png"]);
    const projection = {
      itemId: TARGET, url: TARGET_URL, title: "新商品", priceText: "¥1,000",
      images: ["https://img.test/1.png", "https://img.test/2.png"], files: ["a.zip", "b.zip"],
    };
    assert.equal(snap.json_hash, createHash("sha256").update(JSON.stringify(projection)).digest("hex"));
    await app.close();
  } finally { t.close(); }
});

test("400/404/409 details：invalid URL、item 不存在、STALE、TARGET_MISMATCH、缺 expected/confirm 非 true，零业务写", async () => {
  const t = openTempDb();
  try {
    const { app } = setup(t, { fetchItem: async () => meta() });
    const item = addBoothItem(t);
    const before = snapshot(t.db);
    const invalid = await post(app, item, "preview", { url: "not a booth url" });
    assert.equal(invalid.statusCode, 400);
    assert.equal(errorOf(json(invalid)).code, "INVALID_INPUT");
    assert.equal(detailsOf(json(invalid)).code, "BOOTH_CORRECTION_INVALID_URL");
    const missing = await post(app, 999999, "preview", { url: TARGET_URL });
    assert.equal(missing.statusCode, 404);
    assert.equal(errorOf(json(missing)).code, "NOT_FOUND");
    assert.equal(detailsOf(json(missing)).code, "BOOTH_CORRECTION_ITEM_NOT_FOUND");
    const stale = await post(app, item, "confirm", confirmBody({ expectedSourceItemId: "1111111" }));
    assert.equal(stale.statusCode, 409);
    assert.equal(errorOf(json(stale)).code, "CONFLICT");
    assert.equal(detailsOf(json(stale)).code, "BOOTH_CORRECTION_STALE");
    const mismatch = await post(app, item, "confirm", confirmBody({ expectedTargetItemId: "8888888" }));
    assert.equal(mismatch.statusCode, 409);
    assert.equal(detailsOf(json(mismatch)).code, "BOOTH_CORRECTION_TARGET_MISMATCH");
    const missingExpected = await post(app, item, "confirm", {
      url: TARGET_URL, expectedSourceSite: "booth", expectedSourceItemId: OLD,
      expectedTargetItemId: TARGET, confirm: true,
    });
    assert.equal(missingExpected.statusCode, 400);
    assert.equal(errorOf(json(missingExpected)).code, "INVALID_INPUT");
    const badConfirm = await post(app, item, "confirm", confirmBody({ confirm: false }));
    assert.equal(badConfirm.statusCode, 400);
    assert.equal(errorOf(json(badConfirm)).code, "INVALID_INPUT");
    assert.deepEqual(snapshot(t.db), before);
    await app.close();
  } finally { t.close(); }
});

test("目标被占用（含 trashed）：preview.conflict 与 confirm OCCUPIED details，零业务写", async () => {
  const t = openTempDb();
  try {
    const { app } = setup(t, { fetchItem: async () => meta() });
    const item = addBoothItem(t);
    const owner = addItem(t.db, { title: "占用条目", source_site: "booth", source_item_id: TARGET, status: "trashed" });
    const before = snapshot(t.db);
    const p = await post(app, item, "preview", { url: TARGET_URL });
    assert.equal(p.statusCode, 200);
    assert.deepEqual(json(p).conflict, { itemId: owner, title: "占用条目" });
    const c = await post(app, item, "confirm", confirmBody());
    assert.equal(c.statusCode, 409);
    assert.equal(errorOf(json(c)).code, "CONFLICT");
    assert.equal(detailsOf(json(c)).code, "BOOTH_CORRECTION_OCCUPIED");
    assert.equal(detailsOf(json(c)).conflictItemId, owner);
    assert.equal(detailsOf(json(c)).title, "占用条目");
    assert.deepEqual(snapshot(t.db), before);
    await app.close();
  } finally { t.close(); }
});

test("重复相同成功确认：第二次 changed:false，零新增 audit/snapshot", async () => {
  const t = openTempDb();
  try {
    const { app } = setup(t, { fetchItem: async () => meta() });
    const item = addBoothItem(t);
    const first = await post(app, item, "confirm", confirmBody());
    assert.equal(first.statusCode, 200);
    assert.equal(json(first).changed, true);
    const second = await post(app, item, "confirm", confirmBody({ expectedSourceItemId: TARGET, expectedSourceUrl: TARGET_URL }));
    assert.equal(second.statusCode, 200);
    assert.equal(json(second).changed, false);
    assert.equal(count(t.db, "audit_log"), 1);
    assert.equal(count(t.db, "source_snapshots"), 1);
    await app.close();
  } finally { t.close(); }
});

test("非法 item id：400 INVALID_INPUT，零业务写", async () => {
  const t = openTempDb();
  try {
    const { app } = setup(t, { fetchItem: async () => meta() });
    const item = addBoothItem(t);
    const before = snapshot(t.db);
    for (const id of ["abc", "0", "-1", "1.5"]) {
      const r = await post(app, id, "preview", { url: TARGET_URL });
      assert.equal(r.statusCode, 400, id);
      assert.equal(errorOf(json(r)).code, "INVALID_INPUT", id);
    }
    const valid = await post(app, item, "preview", { url: TARGET_URL });
    assert.equal(valid.statusCode, 200);
    assert.deepEqual(snapshot(t.db), before);
    await app.close();
  } finally { t.close(); }
});
