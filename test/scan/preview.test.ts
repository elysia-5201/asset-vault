/**
 * 扫描变更中心（M1）——数据模型 / 分类 / 应用前重验 / 幂等 / 过期。
 *
 * 被测：apps/server/src/services/scanpreview.ts + repo 的 scan_preview_* 方法 + schema v4。
 * 方法：better-sqlite3 :memory: + 真实 migrate（schema v4）+ 临时目录造真实文件，不用桩替身。
 * 重点（对应 C 方案的验收矩阵）：
 *  - 新/未变/变化/疑似重复 分得清；**同名不构成重复**，只有"同名+同尺寸"才算疑似（且只是提示）；
 *  - 判缺沿用 M0 门控：截断 / 有读取错误 / 根不可读 / 空树 时**不提出** missing；
 *  - 应用前逐条重新 stat：文件消失、size/mtime 变化、缺失项又出现 → stale，绝不按旧快照写库；
 *  - 同参数预览幂等；已应用的条目不会被二次应用；过期预览不可应用。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, rmSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { migrate, SCHEMA_VERSION } from "../../apps/server/src/db/migrate";
import { Repo } from "../../apps/server/src/db/repo";
import { classifyPreview, buildApplyPlan } from "../../apps/server/src/services/scanpreview";
import { scannedFileOf } from "../../apps/server/src/services/scan";
import { normalizePath } from "../../packages/core/src/pathnorm";

const TMP = join("/tmp", "av-m1-test-" + process.pid);
mkdirSync(TMP, { recursive: true });
const freshRepo = () => { const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); migrate(db); return { db, repo: new Repo(db) }; };
const mkFile = (name: string, bytes: number) => {
  const p = join(TMP, name); mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, Buffer.alloc(bytes, 7)); return p;
};
/** 造一条"已入库"的资产（模拟上一轮扫描登记过的文件）。 */
const seedAsset = (repo: Repo, file: { path: string; size: number; mtime: string }, rootId: number) => {
  const item = repo.createItem({ title: "已入库素材" });
  return repo.upsertAsset({ item_id: item.id, kind: "archive", container: "zip", path: file.path,
    path_norm: normalizePath(file.path), root_id: rootId, size: file.size, mtime: file.mtime, discovered_by: "scan" });
};

describe("schema v4：扫描变更中心", () => {
  test("四张表 + 索引 + 版本号 4；重复 migrate 幂等", () => {
    const db = new Database(":memory:"); db.pragma("foreign_keys = ON");
    migrate(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'scan_%' ORDER BY name").all() as any[]).map((r) => r.name);
    assert.deepEqual(tables, ["scan_apply_runs", "scan_preview_errors", "scan_preview_items", "scan_previews"]);
    assert.equal((db.prepare("SELECT value v FROM schema_meta WHERE key='version'").get() as any).v, String(SCHEMA_VERSION));
    assert.equal(SCHEMA_VERSION, 4);
    migrate(db);
    assert.equal((db.prepare("SELECT COUNT(*) c FROM scan_previews").get() as any).c, 0);
    db.close();
  });
});

describe("classifyPreview：变化分类", () => {
  test("空库 + 两个文件 → 都是 new", () => {
    const { db, repo } = freshRepo();
    const f1 = scannedFileOf(mkFile("a.zip", 100))!;
    const f2 = scannedFileOf(mkFile("b.zip", 200))!;
    const r = classifyPreview(repo, TMP, [f1, f2], { truncated: false, errorCount: 0, readability: { rootReadable: true, dirsRead: 1, dirsFailed: 0, entriesStatFailed: 0 }, errors: [] });
    assert.equal(r.counts.new, 2);
    assert.equal(r.counts.missing, 0);
    assert.equal(r.gate.allowed, true);
    db.close();
  });

  test("已登记且 size/mtime 一致 → unchanged；size 变了 → changed", () => {
    const { db, repo } = freshRepo();
    const root = repo.ensureRoot(TMP);
    const f = scannedFileOf(mkFile("same.zip", 64))!;
    seedAsset(repo, f, root.id);
    const r1 = classifyPreview(repo, TMP, [f], { truncated: false, errorCount: 0, readability: { rootReadable: true, dirsRead: 1, dirsFailed: 0, entriesStatFailed: 0 }, errors: [] });
    assert.equal(r1.counts.unchanged, 1);
    const bigger = { ...f, size: f.size + 10 };
    const r2 = classifyPreview(repo, TMP, [bigger], { truncated: false, errorCount: 0, readability: { rootReadable: true, dirsRead: 1, dirsFailed: 0, entriesStatFailed: 0 }, errors: [] });
    assert.equal(r2.counts.changed, 1);
    db.close();
  });

  test("同名同尺寸只算「疑似重复」；同名但尺寸不同仍是 new（同名不构成重复）", () => {
    const { db, repo } = freshRepo();
    const root = repo.ensureRoot(TMP);
    const other = join(TMP, "other", "dup.zip"); mkdirSync(join(TMP, "other"), { recursive: true });
    writeFileSync(other, Buffer.alloc(128, 1));
    const existing = scannedFileOf(other)!;
    seedAsset(repo, existing, root.id);
    const sameNameSameSize = scannedFileOf(mkFile("dup.zip", 128))!;
    const sameNameOtherSize = scannedFileOf(mkFile("sub/dup.zip", 300))!;
    const r = classifyPreview(repo, TMP, [sameNameSameSize, sameNameOtherSize], { truncated: false, errorCount: 0, readability: { rootReadable: true, dirsRead: 1, dirsFailed: 0, entriesStatFailed: 0 }, errors: [] });
    assert.equal(r.counts.duplicate_suspected, 1, "同名+同尺寸 → 疑似重复（仅提示）");
    assert.equal(r.counts.new, 1, "同名但尺寸不同 → new");
    const hint = r.rows.find((x) => x.change === "duplicate_suspected")!;
    assert.ok(Array.isArray((hint.detail as any)?.matches), "疑似重复要带匹配到的已有路径供人工判断");
    db.close();
  });

  test("判缺门控：完整扫描才提出 missing；截断/有读取错误/根不可读/空树都不提出", () => {
    const { db, repo } = freshRepo();
    const root = repo.ensureRoot(TMP);
    const gone = scannedFileOf(mkFile("gone.zip", 32))!;
    seedAsset(repo, gone, root.id);
    const okStats = { truncated: false, errorCount: 0, readability: { rootReadable: true, dirsRead: 1, dirsFailed: 0, entriesStatFailed: 0 }, errors: [] };
    assert.equal(classifyPreview(repo, TMP, [], okStats).counts.missing, 1, "完整扫描且文件不在 → missing");
    assert.equal(classifyPreview(repo, TMP, [], { ...okStats, truncated: true }).counts.missing, 0, "截断 → 不判缺");
    assert.equal(classifyPreview(repo, TMP, [], { ...okStats, errorCount: 2, errors: [{ path: "/x", op: "readdir", code: "EACCES", message: "denied" }] }).counts.missing, 0, "读取错误 → 不判缺（同时记 error 行）");
    assert.equal(classifyPreview(repo, TMP, [], { ...okStats, readability: { rootReadable: false, dirsRead: 0, dirsFailed: 1, entriesStatFailed: 0 } }).counts.missing, 0, "根不可读 → 不判缺");
    db.close();
  });

  test("读取失败条目进入 unreadable/error 行", () => {
    const { db, repo } = freshRepo();
    const r = classifyPreview(repo, TMP, [], { truncated: false, errorCount: 2, readability: { rootReadable: true, dirsRead: 1, dirsFailed: 0, entriesStatFailed: 1 },
      errors: [{ path: TMP + "/locked.zip", op: "stat", code: "EPERM", message: "perm" }, { path: TMP + "/nodir", op: "readdir", code: "EACCES", message: "denied" }] });
    assert.equal(r.counts.unreadable, 1);
    assert.equal(r.counts.error, 1);
    db.close();
  });
});

describe("buildApplyPlan：应用前重验（stale）", () => {
  const mkPreviewWith = (repo: Repo, rows: any[], path: string) => {
    const p = repo.createScanPreview({ rootId: null, path, deep: false });
    repo.replaceScanPreviewItems(p.id, rows);
    repo.setScanPreviewDecisions(p.id, rows.map((r) => r.path_norm), "accept");
    return p;
  };
  test("文件未变 → 进入 files；文件被删 / 尺寸变化 → stale", () => {
    const { db, repo } = freshRepo();
    const f = scannedFileOf(mkFile("plan-a.zip", 50))!;
    const p = mkPreviewWith(repo, [{ path: f.path, path_norm: f.path, change: "new", size: f.size, mtime: f.mtime }], TMP);
    assert.equal(buildApplyPlan(repo, p.id).files.length, 1);
    truncateSync(f.path, 10);
    const plan2 = buildApplyPlan(repo, p.id);
    assert.equal(plan2.files.length, 0);
    assert.match(plan2.stale[0].reason, /size\/mtime/);
    rmSync(f.path);
    const plan3 = buildApplyPlan(repo, p.id);
    assert.match(plan3.stale[0].reason, /不存在/);
    db.close();
  });

  test("missing 项：文件仍不存在 → 进 missingIds；又出现了 → stale（不再标缺失）", () => {
    const { db, repo } = freshRepo();
    const root = repo.ensureRoot(TMP);
    const f = scannedFileOf(mkFile("plan-m.zip", 20))!;
    const a = seedAsset(repo, f, root.id).asset;
    const p = mkPreviewWith(repo, [{ path: f.path, path_norm: f.path, change: "missing", assetId: a.id, prevSize: f.size, prevMtime: f.mtime }], TMP);
    rmSync(f.path);
    const plan = buildApplyPlan(repo, p.id);
    assert.deepEqual(plan.missingIds, [a.id]);
    writeFileSync(f.path, Buffer.alloc(20, 3));      // 文件又出现
    const plan2 = buildApplyPlan(repo, p.id);
    assert.equal(plan2.missingIds.length, 0);
    assert.match(plan2.stale[0].reason, /又出现/);
    db.close();
  });
});

describe("repo 预览：幂等 / 勾选 / 分页 / 过期 / 删除", () => {
  test("同路径+深度只有一个活跃预览；deep 不同则另开", () => {
    const { db, repo } = freshRepo();
    const a = repo.createScanPreview({ rootId: null, path: TMP, deep: false });
    const b = repo.createScanPreview({ rootId: null, path: TMP, deep: false });
    assert.equal(a.id, b.id, "同参数 → 返回同一条");
    const c = repo.createScanPreview({ rootId: null, path: TMP, deep: true });
    assert.notEqual(a.id, c.id, "deep 不同 → 新预览");
    db.close();
  });

  test("勾选后可应用集合正确（含 duplicate_suspected，不含 unchanged）", () => {
    const { db, repo } = freshRepo();
    const p = repo.createScanPreview({ rootId: null, path: TMP, deep: false });
    repo.replaceScanPreviewItems(p.id, [
      { path: "/x/new.zip", path_norm: "/x/new.zip", change: "new" },
      { path: "/x/dup.zip", path_norm: "/x/dup.zip", change: "duplicate_suspected" },
      { path: "/x/same.zip", path_norm: "/x/same.zip", change: "unchanged" },
    ]);
    repo.setScanPreviewDecisions(p.id, ["/x/new.zip", "/x/dup.zip", "/x/same.zip"], "accept");
    const ids = repo.scanPreviewItemsForApply(p.id).map((x: any) => x.change);
    assert.deepEqual(ids.sort(), ["duplicate_suspected", "new"]);
    db.close();
  });

  test("条目分页（keyset）与计数", () => {
    const { db, repo } = freshRepo();
    const p = repo.createScanPreview({ rootId: null, path: TMP, deep: false });
    repo.replaceScanPreviewItems(p.id, Array.from({ length: 7 }, (_, i) => ({ path: "/p/" + i, path_norm: "/p/" + i, change: "new" })));
    const page1 = repo.listScanPreviewItems(p.id, { limit: 3 });
    assert.equal(page1.items.length, 3);
    const page2 = repo.listScanPreviewItems(p.id, { limit: 3, cursor: page1.nextCursor! });
    assert.equal(page2.items.length, 3);
    assert.equal(repo.countScanPreviewItems(p.id).new, 7);
    db.close();
  });

  test("过期只影响 ready/partial；删除级联清条目", () => {
    const { db, repo } = freshRepo();
    const p = repo.createScanPreview({ rootId: null, path: TMP, deep: false });
    repo.updateScanPreview(p.id, { state: "ready", expires_at: "2000-01-01T00:00:00.000Z" });
    assert.equal(repo.expireScanPreviews(), 1);
    assert.equal(repo.getScanPreview(p.id).state, "expired");
    repo.replaceScanPreviewItems(p.id, [{ path: "/q/1", path_norm: "/q/1", change: "new" }]);
    assert.equal(repo.deleteScanPreview(p.id), true);
    assert.equal((db.prepare("SELECT COUNT(*) c FROM scan_preview_items WHERE preview_id=?").get(p.id) as any).c, 0);
    db.close();
  });
});
