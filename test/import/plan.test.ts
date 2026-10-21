/**
 * task-38：导入计划（precheck / mixed / 指纹 / suggested / 独立状态）
 * 关键约束：mixed 计划永远引用原始整包；指纹变化 → blocked；suggested 不自动加入；每单元独立状态。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTempDb, addItem, addRoot, addAsset, addAvatar, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { analyzeItemStructure, createImportPlan, confirmImportPlan, getPlanView } from "../../apps/server/src/services/structure";

let t: TempDb; let repo: Repo; let rootId: number; let itemId: number; let dir: string;
const mk = (name: string, bytes = 16) => { const p = join(dir, name); writeFileSync(p, Buffer.alloc(bytes, 3)); return p; };
const addUpkg = (path: string) => addAsset(t.db, itemId, rootId, path, {
  kind: "unitypackage", container: "unitypackage", path, path_norm: path, size: 16, mtime: "2026-10-02T00:00:00.000Z", sha256: "0123456789abcdef",
});
const unitOfAsset = (assetId: number) => (repo.listUnits({ itemId }).find((u) => Number(u.asset_id) === assetId && u.importable) as any);
beforeEach(() => {
  t = openTempDb(); repo = new Repo(t.db); rootId = addRoot(t.db, "/lib"); itemId = addItem(t.db, { title: "计划测试" });
  dir = mkdtempSync(join(tmpdir(), "av-plan-"));
  addAvatar(t.db, "Manuka"); addAvatar(t.db, "Moe");
});
afterEach(() => { t.close(); rmSync(dir, { recursive: true, force: true }); });

async function twoUnits() {
  const a1 = addUpkg(mk("Manuka.unitypackage")); const a2 = addUpkg(mk("Moe.unitypackage"));
  repo.replaceUnityPackageAssets(a1, [{ guid: "g1", assetPath: "Assets/Manuka/x.fbx", type: "Model", size: 1, hasPreview: false }]);
  repo.replaceUnityPackageAssets(a2, [{ guid: "g2", assetPath: "Assets/Moe/y.fbx", type: "Model", size: 1, hasPreview: false }]);
  t.db.prepare("UPDATE assets SET index_state='done' WHERE id IN (?,?)").run(a1, a2);
  await analyzeItemStructure(repo, itemId);
  return { a1, a2, u1: unitOfAsset(a1), u2: unitOfAsset(a2) };
}

describe("createImportPlan", () => {
  test("mixed 单元：plan_item.path 永远 = 原始整包路径，不产生筛选/暂存文件", async () => {
    const p = mk("Manuka_Moe.unitypackage", 32);
    const a = addAsset(t.db, itemId, rootId, p, { kind: "unitypackage", container: "unitypackage", path: p, path_norm: p, size: 32, mtime: "2026-10-02T00:00:00.000Z" });
    repo.replaceUnityPackageAssets(a, [
      { guid: "g1", assetPath: "Assets/Manuka/a.fbx", type: "Model", size: 1, hasPreview: false },
      { guid: "g2", assetPath: "Assets/Moe/b.fbx", type: "Model", size: 1, hasPreview: false },
    ]);
    t.db.prepare("UPDATE assets SET index_state='done' WHERE id=?").run(a);
    await analyzeItemStructure(repo, itemId);
    const unit = unitOfAsset(a);
    assert.equal(unit.policy, "mixed_unitypackage");
    const view = createImportPlan(repo, { unitIds: [unit.id], projectPath: join(dir, "UnityProject") });
    assert.equal(view.items.length, 1);
    assert.equal(view.items[0].path, p, "计划必须指向原始整包");
    assert.equal(view.items[0].policy, "mixed_unitypackage");
    assert.equal(view.plan.status, "needs_confirmation", "混合包需要人工确认");
    // 计划阶段不落地任何暂存/筛选产物
    assert.equal(existsSync(join(dir, "unity-staging")), false);
    assert.ok(!String(view.items[0].path).includes("filtered"), "绝不出现筛选包路径");
  });

  test("压缩包内条目：plan 指纹按条目 size 校验，未变化时 ready（不是恒 blocked）", async () => {
    const p = mk("bundle.zip", 64);
    const a = addAsset(t.db, itemId, rootId, p, { kind: "archive", container: "zip", path: p, path_norm: p, size: 64, mtime: "2026-10-02T00:00:00.000Z" });
    t.db.prepare("INSERT INTO archive_entries(asset_id,entry_path,entry_size,is_dir,ext) VALUES (?,?,?,0,'.unitypackage')").run(a, "Manuka/only.unitypackage", 33);
    t.db.prepare("UPDATE assets SET index_state='done' WHERE id=?").run(a);
    await analyzeItemStructure(repo, itemId);
    const unit = repo.listUnits({ itemId }).find((u) => Number(u.asset_id) === a && u.importable)!;
    assert.equal(unit.size, 33, "单元 size 用内层条目大小");
    const view = createImportPlan(repo, { unitIds: [Number(unit.id)], projectPath: join(dir, "UnityProject") });
    assert.equal(view.plan.status, "ready", "条目不变化时不得误报 blocked：" + JSON.stringify(view.precheck));
    assert.equal(view.items[0].fingerprint, unit.fingerprint);
  });

  test("指纹变化 → plan blocked，且只有变化的条目 blocked（条目独立状态）", async () => {
    const { a1, u1, u2 } = await twoUnits();
    assert.ok(u1 && u2);
    const t0 = createImportPlan(repo, { unitIds: [u1.id, u2.id], projectPath: dir });
    assert.equal(t0.plan.status, "ready");
    // 只改 a1 的 mtime → 单元指纹（analyze 时写入）与当前不一致
    t.db.prepare("UPDATE assets SET mtime='2026-10-09T00:00:00.000Z' WHERE id=?").run(a1);
    const t1 = createImportPlan(repo, { unitIds: [u1.id, u2.id], projectPath: dir });
    assert.equal(t1.plan.status, "blocked");
    const blocked = t1.items.filter((i: any) => i.status === "blocked");
    assert.equal(blocked.length, 1);
    assert.equal(Number(blocked[0].asset_id), a1);
    assert.match(String(blocked[0].error), /指纹/);
    const ok = t1.items.filter((i: any) => i.status === "pending");
    assert.equal(ok.length, 1, "未变化的条目仍 pending（独立状态）");
    assert.throws(() => confirmImportPlan(repo, t1.plan.id), /precheck|阻断/);
  });

  test("suggested：includeSuggested=false 不加入；true 才加入且标 suggested，confirm 后转 pending", async () => {
    const { a1, a2, u1, u2 } = await twoUnits();
    // 人工造一条 suggested_companion：u1 → u2
    repo.replaceUnitRelations([Number(u1.id)], [{ fromUnitId: Number(u1.id), toUnitId: Number(u2.id), type: "suggested_companion", evidence: "同名伴生", confidence: "probable" }]);
    const plain = createImportPlan(repo, { unitIds: [Number(u1.id)], projectPath: dir });
    assert.equal(plain.items.length, 1, "不勾选 includeSuggested 时不加建议项");
    assert.ok(plain.items.every((i: any) => i.status !== "suggested"));
    const withSug = createImportPlan(repo, { unitIds: [Number(u1.id)], projectPath: dir, includeSuggested: true });
    assert.equal(withSug.items.length, 2);
    const sug = withSug.items.find((i: any) => i.status === "suggested");
    assert.ok(sug, "建议项必须显式标 suggested");
    assert.equal(Number(sug.asset_id), a2);
    assert.equal(withSug.plan.status, "needs_confirmation");
    const confirmed = confirmImportPlan(repo, withSug.plan.id);
    assert.equal(confirmed.plan.user_confirmed, 1);
    assert.ok(confirmed.items.every((i: any) => i.status !== "suggested"), "确认后建议项转 pending");
    void a1;
  });

  test("非 importable / 跨条目 / 空 projectPath 一律拒绝", async () => {
    const p = mk("broken.zip"); const a = addAsset(t.db, itemId, rootId, p, { kind: "archive", container: "zip", path: p, path_norm: p, size: 16, mtime: "2026-10-02T00:00:00.000Z", index_state: "failed", index_error: "broken" });
    await analyzeItemStructure(repo, itemId);
    const bad = repo.listUnits({ itemId }).find((u) => Number(u.asset_id) === a)!;
    assert.equal(bad.importable, 0);
    assert.throws(() => createImportPlan(repo, { unitIds: [Number(bad.id)], projectPath: dir }), /不可导入/);
    assert.throws(() => createImportPlan(repo, { unitIds: [], projectPath: dir }), /unitIds/);
    const { u1 } = await twoUnits();
    assert.throws(() => createImportPlan(repo, { unitIds: [Number(u1.id)], projectPath: "" }), /projectPath/);
  });
});
