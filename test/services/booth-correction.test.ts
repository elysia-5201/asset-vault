/**
 * BOOTH 更正服务（task-70；frozen-interface-B1.md）。
 *
 * 真实 Repo + 真实临时 SQLite；只闭合 booth.fetchItem，不联网。
 * 覆盖：preview 零写/投影、成功全保留、同 id URL 修正+真 noop、占用含 trashed、
 * 异步 fetch 期间 CAS、target mismatch、audit/snapshot 失败全回滚、unique 兜底。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openTempDb, addItem, addRoot, addAsset, addImage, addAvatar, count, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { confirmBoothCorrection, previewBoothCorrection, type BoothCorrectionDeps } from "../../apps/server/src/services/booth-correction";
import type { BoothItemMeta } from "../../packages/core/src/contracts";

const NOW = "2026-11-05T00:00:00.000Z";
const OLD = "1234567";
const TARGET = "7654321";
const OLD_URL = "https://booth.pm/ja/items/" + OLD;
const TARGET_URL = "https://booth.pm/ja/items/" + TARGET;

function meta(over: Partial<BoothItemMeta> = {}): BoothItemMeta {
  return {
    itemId: TARGET,
    title: "新商品",
    description: "新描述",
    priceText: "¥1,000",
    priceYen: 1000,
    publishedAt: "2026-01-02T03:04:05.000Z",
    isAdult: false,
    url: TARGET_URL,
    shop: { name: "店", subdomain: "shop" },
    tags: [{ name: "tag1" }, { name: "tag2" }],
    category: { id: 1, name: "衣装", parent: { name: "服" } },
    images: [{ original: "https://img.test/1.png" }, { original: "https://img.test/2.png" }],
    variations: [{ id: 1, price: 1000, files: [
      { name: "a.zip", file_size: "10", url: "https://dl.test/a" },
      { name: "b.zip", file_size: "20", url: "https://dl.test/b" },
    ] }],
    ...over,
  };
}

function setup(metaOver: Partial<BoothItemMeta> = {}, opts: { now?: string } = {}) {
  const t = openTempDb();
  const repo = new Repo(t.db);
  const deps: BoothCorrectionDeps = {
    repo,
    booth: { fetchItem: async () => meta(metaOver) },
    now: () => opts.now ?? NOW,
  };
  return { t, repo, deps };
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
    sourceSite: r.source_site ?? null,
    sourceItemId: r.source_item_id ?? null,
    sourceUrl: r.source_url ?? null,
    canonicalUrl: r.canonical_url ?? null,
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
    url: TARGET_URL,
    expectedSourceSite: "booth",
    expectedSourceItemId: OLD,
    expectedSourceUrl: OLD_URL,
    expectedTargetItemId: TARGET,
    confirm: true,
    ...over,
  };
}

async function rejectsApp(p: Promise<unknown>, code: string, detailsCode?: string) {
  await assert.rejects(p, (e: any) => {
    assert.equal(e.code, code);
    if (detailsCode) assert.equal(e.details?.code, detailsCode);
    return true;
  });
}

function assertPreserved(before: any, after: any) {
  const source = new Set(["source_site", "source_item_id", "source_url", "canonical_url", "source_gone", "last_checked_at", "updated_at"]);
  for (const k of Object.keys(before)) if (!source.has(k)) assert.deepEqual(after[k], before[k], k);
}

function richItem(t: TempDb, repo: Repo): { item: number; avatar: number } {
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
  return { item, avatar };
}

test("preview：旧绑定/目标投影/冲突空，业务 DB 零写", async () => {
  const { t, repo, deps } = setup();
  const item = addBoothItem(t);
  repo.setItemTags(item, ["keep"], "manual");
  const before = snapshot(t.db);
  const p = await previewBoothCorrection(deps, item, { url: TARGET_URL });
  assert.equal(p.itemId, item);
  assert.deepEqual(p.current, { sourceSite: "booth", sourceItemId: OLD, sourceUrl: OLD_URL, canonicalUrl: OLD_URL, sourceGone: false });
  assert.deepEqual(p.target, {
    itemId: TARGET, url: TARGET_URL, canonicalUrl: TARGET_URL, title: "新商品",
    shop: { name: "店", subdomain: "shop" }, priceText: "¥1,000", priceYen: 1000,
    publishedAt: "2026-01-02T03:04:05.000Z", isAdult: false,
    category: { name: "衣装", parent: "服" }, tags: ["tag1", "tag2"], imageCount: 2, fileCount: 2,
  });
  assert.equal(p.conflict, null);
  assert.ok(p.willChange.includes("source_snapshot"));
  assert.ok(p.willChange.includes("audit"));
  assert.ok(p.willPreserve.includes("title"));
  assert.ok(p.willPreserve.includes("assets"));
  assert.ok(p.willPreserve.includes("tags"));
  assert.ok(p.willPreserve.includes("images"));
  assert.ok(p.willPreserve.includes("avatars"));
  assert.deepEqual(snapshot(t.db), before);
  t.close();
});

test("confirm 成功：只改来源身份，非 source 资料/资产/标签/图/头像全保留，audit+snapshot 同事务", async () => {
  const { t, repo, deps } = setup();
  const { item } = richItem(t, repo);
  const beforeRow = row(t, item);
  const beforeTables = snapshot(t.db);
  const res = await confirmBoothCorrection(deps, item, confirmBody());
  assert.equal(res.changed, true);
  assert.equal(res.itemId, item);
  assert.deepEqual(res.previousBinding, binding(beforeRow));
  const afterRow = row(t, item);
  assert.equal(afterRow.source_site, "booth");
  assert.equal(afterRow.source_item_id, TARGET);
  assert.equal(afterRow.source_url, TARGET_URL);
  assert.equal(afterRow.canonical_url, TARGET_URL);
  assert.equal(afterRow.source_gone, 0);
  assert.equal(afterRow.last_checked_at, NOW);
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
  assert.equal(res.item.item.source_item_id, TARGET);
  assert.equal(res.item.images.length, 1);
  assert.equal(res.item.assets.length, 1);
  assert.deepEqual(res.item.tags, ["keep"]);
  assert.equal(res.item.avatars.length, 1);
  t.close();
});

test("同 id 但旧 URL/规范 URL 错或 sourceGone=1：实际修正；再确认才真 noop", async () => {
  const { t, repo, deps } = setup();
  const item = addBoothItem(t, {
    source_url: "https://booth.pm/ja/items/9999999",
    canonical_url: "https://booth.pm/ja/items/9999999",
    source_gone: 1,
  });
  const first = await confirmBoothCorrection(deps, item, confirmBody({ expectedSourceUrl: "https://booth.pm/ja/items/9999999" }));
  assert.equal(first.changed, true);
  const fixed = row(t, item);
  assert.equal(fixed.source_item_id, TARGET);
  assert.equal(fixed.source_url, TARGET_URL);
  assert.equal(fixed.canonical_url, TARGET_URL);
  assert.equal(fixed.source_gone, 0);
  assert.equal(count(t.db, "audit_log"), 1);
  assert.equal(count(t.db, "source_snapshots"), 1);
  const second = await confirmBoothCorrection(deps, item, confirmBody({ expectedSourceItemId: TARGET, expectedSourceUrl: TARGET_URL }));
  assert.equal(second.changed, false);
  assert.deepEqual(second.previousBinding, second.currentBinding);
  assert.deepEqual(row(t, item), fixed);
  assert.equal(count(t.db, "audit_log"), 1);
  assert.equal(count(t.db, "source_snapshots"), 1);
  t.close();
});

test("目标被占用（含 trashed）：preview.conflict 与 confirm OCCUPIED，零业务写", async () => {
  const { t, deps } = setup();
  const item = addBoothItem(t);
  const owner = addItem(t.db, { title: "占用条目", source_site: "booth", source_item_id: TARGET, status: "trashed" });
  const before = snapshot(t.db);
  const p = await previewBoothCorrection(deps, item, { url: TARGET_URL });
  assert.deepEqual(p.conflict, { itemId: owner, title: "占用条目" });
  await assert.rejects(confirmBoothCorrection(deps, item, confirmBody()), (e: any) => {
    assert.equal(e.code, "CONFLICT");
    assert.equal(e.details.code, "BOOTH_CORRECTION_OCCUPIED");
    assert.equal(e.details.conflictItemId, owner);
    assert.equal(e.details.title, "占用条目");
    return true;
  });
  assert.deepEqual(snapshot(t.db), before);
  t.close();
});

test("异步 fetch 期间旧 binding 变化：CAS 拒绝 STALE，零业务写", async () => {
  const { t, repo, deps } = setup();
  const item = addBoothItem(t);
  let resolveFetch!: (m: BoothItemMeta) => void;
  const pending = new Promise<BoothItemMeta>((r) => { resolveFetch = r; });
  const deps2: BoothCorrectionDeps = { ...deps, booth: { fetchItem: () => pending } };
  const p = confirmBoothCorrection(deps2, item, confirmBody());
  repo.updateItem(item, {
    source_site: "booth", source_item_id: "1111111",
    source_url: "https://booth.pm/ja/items/1111111", canonical_url: "https://booth.pm/ja/items/1111111",
  });
  resolveFetch(meta());
  await rejectsApp(p, "CONFLICT", "BOOTH_CORRECTION_STALE");
  assert.equal(row(t, item).source_item_id, "1111111");
  assert.equal(count(t.db, "audit_log"), 0);
  assert.equal(count(t.db, "source_snapshots"), 0);
  t.close();
});

test("expectedTargetItemId 与 parsed/meta 不一致：TARGET_MISMATCH，零业务写", async () => {
  const { t, deps } = setup();
  const item = addBoothItem(t);
  await rejectsApp(confirmBoothCorrection(deps, item, confirmBody({ expectedTargetItemId: "8888888" })), "CONFLICT", "BOOTH_CORRECTION_TARGET_MISMATCH");
  const deps2: BoothCorrectionDeps = { ...deps, booth: { fetchItem: async () => meta({ itemId: "9999999" }) } };
  await rejectsApp(confirmBoothCorrection(deps2, item, confirmBody()), "CONFLICT", "BOOTH_CORRECTION_TARGET_MISMATCH");
  assert.equal(count(t.db, "audit_log"), 0);
  assert.equal(count(t.db, "source_snapshots"), 0);
  t.close();
});

test("audit 失败：update 回滚，零 audit/snapshot", async () => {
  const { t, deps } = setup();
  const item = addBoothItem(t);
  const before = row(t, item);
  t.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit fail'); END");
  try {
    await assert.rejects(confirmBoothCorrection(deps, item, confirmBody()), (e: any) => {
      assert.match(String(e?.message ?? e), /audit fail/);
      return true;
    });
  } finally {
    t.db.exec("DROP TRIGGER fail_audit");
  }
  assert.deepEqual(row(t, item), before);
  assert.equal(count(t.db, "audit_log"), 0);
  assert.equal(count(t.db, "source_snapshots"), 0);
  t.close();
});

test("snapshot 失败：update+audit 回滚，零 audit/snapshot", async () => {
  const { t, deps } = setup();
  const item = addBoothItem(t);
  const before = row(t, item);
  t.db.exec("CREATE TRIGGER fail_snapshot BEFORE INSERT ON source_snapshots BEGIN SELECT RAISE(ABORT, 'snapshot fail'); END");
  try {
    await assert.rejects(confirmBoothCorrection(deps, item, confirmBody()), (e: any) => {
      assert.match(String(e?.message ?? e), /snapshot fail/);
      return true;
    });
  } finally {
    t.db.exec("DROP TRIGGER fail_snapshot");
  }
  assert.deepEqual(row(t, item), before);
  assert.equal(count(t.db, "audit_log"), 0);
  assert.equal(count(t.db, "source_snapshots"), 0);
  t.close();
});

test("invalid URL/404/expected 缺字段/类型/未知字段：INVALID_INPUT 或 NOT_FOUND，零业务写", async () => {
  const { t, deps } = setup();
  const item = addBoothItem(t);
  const before = snapshot(t.db);
  await rejectsApp(previewBoothCorrection(deps, item, { url: "not a booth url" }), "INVALID_INPUT", "BOOTH_CORRECTION_INVALID_URL");
  await rejectsApp(previewBoothCorrection(deps, 999999, { url: TARGET_URL }), "NOT_FOUND", "BOOTH_CORRECTION_ITEM_NOT_FOUND");
  await rejectsApp(confirmBoothCorrection(deps, item, {
    url: TARGET_URL, expectedSourceSite: "booth", expectedSourceItemId: OLD,
    expectedTargetItemId: TARGET, confirm: true,
  }), "INVALID_INPUT");
  await rejectsApp(confirmBoothCorrection(deps, item, confirmBody({ confirm: false })), "INVALID_INPUT");
  await rejectsApp(confirmBoothCorrection(deps, item, confirmBody({ expectedSourceSite: "bogus" })), "INVALID_INPUT");
  await rejectsApp(confirmBoothCorrection(deps, item, confirmBody({ expectedTargetItemId: 123 })), "INVALID_INPUT");
  await rejectsApp(confirmBoothCorrection(deps, item, confirmBody({ extra: true })), "INVALID_INPUT");
  assert.deepEqual(snapshot(t.db), before);
  t.close();
});

test("unique 兜底：只匹配本 source 唯一约束，映射 OCCUPIED 且零业务写", async () => {
  const { t, repo, deps } = setup();
  const item = addBoothItem(t);
  const owner = addItem(t.db, { title: "占用条目", source_site: "booth", source_item_id: TARGET });
  let ownerChecks = 0;
  const fakeRepo = {
    transaction: (fn: () => unknown) => repo.transaction(fn),
    getItem: (id: number) => repo.getItem(id),
    getItemBySource: (site: any, id: string) => {
      ownerChecks++;
      if (ownerChecks === 1) return null;
      return repo.getItemBySource(site, id);
    },
    updateItem: () => {
      const e: any = new Error("UNIQUE constraint failed: items.source_site, items.source_item_id");
      e.code = "SQLITE_CONSTRAINT_UNIQUE";
      throw e;
    },
    logAudit: () => { throw new Error("audit should not run"); },
    addSnapshot: () => { throw new Error("snapshot should not run"); },
  } as any;
  await assert.rejects(confirmBoothCorrection({ ...deps, repo: fakeRepo }, item, confirmBody()), (e: any) => {
    assert.equal(e.code, "CONFLICT");
    assert.equal(e.details.code, "BOOTH_CORRECTION_OCCUPIED");
    assert.equal(e.details.conflictItemId, owner);
    assert.equal(e.details.title, "占用条目");
    return true;
  });
  assert.equal(ownerChecks, 2);
  assert.equal(row(t, item).source_item_id, OLD);
  assert.equal(count(t.db, "audit_log"), 0);
  assert.equal(count(t.db, "source_snapshots"), 0);
  t.close();
});
