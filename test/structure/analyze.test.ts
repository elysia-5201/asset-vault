/**
 * task-38：结构分析（asset_units / unit_relations）
 * 覆盖：zip 多 upkg → multi_package_container；单混合 upkg → mixed 且整包；zip 内 1 个混合包仍 mixed；
 *       损坏/未解析 → unknown + failed，不伪造；重复分析幂等。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { path7za } from "7zip-bin";
import { join } from "node:path";
import { openTempDb, addItem, addRoot, addAsset, addAvatar, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { analyzeItemStructure, createImportPlan } from "../../apps/server/src/services/structure";

let t: TempDb; let repo: Repo; let rootId: number; let itemId: number; let dir: string;
const file = (name: string, bytes = 8) => { const p = join(dir, name); writeFileSync(p, Buffer.alloc(bytes, 1)); return p; };
const archive = (path: string, o: any = {}) => addAsset(t.db, itemId, rootId, path, { kind: "archive", container: "zip", path, path_norm: path, size: 100, mtime: "2026-10-01T00:00:00.000Z", ...o });
const upkg = (path: string, o: any = {}) => addAsset(t.db, itemId, rootId, path, { kind: "unitypackage", container: "unitypackage", path, path_norm: path, size: 100, mtime: "2026-10-01T00:00:00.000Z", ...o });
const unitsOf = (id = itemId) => repo.listUnits({ itemId: id });
beforeEach(() => {
  t = openTempDb(); repo = new Repo(t.db); rootId = addRoot(t.db, "/lib"); itemId = addItem(t.db, { title: "结构测试" });
  dir = mkdtempSync(join(tmpdir(), "av-structure-"));
});
afterEach(() => { t.close(); rmSync(dir, { recursive: true, force: true }); });

describe("analyzeItemStructure", () => {
  test("zip 内 2 个独立 unitypackage → 容器 multi_package_container + 2 个可导入单元", async () => {
    const p = file("two.zip");
    const a = archive(p);
    t.db.prepare("INSERT INTO archive_entries(asset_id,entry_path,entry_size,is_dir,ext) VALUES (?,?,?,0,'.unitypackage')").run(a, "Manuka/model.unitypackage", 10);
    t.db.prepare("INSERT INTO archive_entries(asset_id,entry_path,entry_size,is_dir,ext) VALUES (?,?,?,0,'.unitypackage')").run(a, "Moe/model.unitypackage", 12);
    addAvatar(t.db, "Manuka"); addAvatar(t.db, "Moe");
    const r = await analyzeItemStructure(repo, itemId);
    assert.equal(r.errors.length, 0);
    const units = unitsOf();
    assert.equal(units.length, 3, "容器 + 2 包");
    const container = units.find((u) => u.rel_path === "");
    assert.ok(container);
    assert.equal(container.policy, "multi_package_container");
    assert.equal(container.importable, 0, "容器本身不可直接导入");
    const pkgs = units.filter((u) => u.rel_path !== "");
    assert.equal(pkgs.length, 2);
    for (const u of pkgs) {
      assert.ok([ "single_unitypackage", "unknown_structure" ].includes(u.policy), "单包只能是 single/unknown，实际 " + u.policy);
      assert.equal(u.importable, u.policy === "single_unitypackage" ? 1 : 0);
      assert.ok(JSON.parse(u.avatar_json).length >= 1, "包内路径应识别出 avatar 证据");
    }
  });

  test("单个混合 unitypackage → mixed_unitypackage，importable=1（引用整包）", async () => {
    const p = file("mixed.unitypackage");
    const a = upkg(p, { sha256: "abcdef0123456789" });
    addAvatar(t.db, "Manuka"); addAvatar(t.db, "Moe");
    repo.replaceUnityPackageAssets(a, [
      { guid: "g1", assetPath: "Assets/Manuka/body.fbx", type: "Model", size: 1, hasPreview: false },
      { guid: "g2", assetPath: "Assets/Moe/hair.fbx", type: "Model", size: 1, hasPreview: false },
    ]);
    t.db.prepare("UPDATE assets SET index_state='done' WHERE id=?").run(a);
    const r = await analyzeItemStructure(repo, itemId);
    assert.equal(r.errors.length, 0);
    const units = unitsOf();
    assert.equal(units.length, 1);
    assert.equal(units[0].policy, "mixed_unitypackage");
    assert.equal(units[0].importable, 1);
    assert.equal(units[0].rel_path, "mixed.unitypackage");
    assert.equal(units[0].fingerprint, "100:2026-10-01T00:00:00.000Z:abcdef01");
    const avatars = JSON.parse(units[0].avatar_json);
    assert.ok(avatars.length >= 2, "两个模型证据都要保留");
  });

  test("zip 内只有 1 个混合包 → 仍 mixed（外层 ZIP 不构成可拆理由）", async () => {
    const p = file("one-mixed.zip");
    const a = archive(p);
    addAvatar(t.db, "Manuka"); addAvatar(t.db, "Moe");
    t.db.prepare("INSERT INTO archive_entries(asset_id,entry_path,entry_size,is_dir,ext) VALUES (?,?,?,0,'.unitypackage')").run(a, "Manuka_and_Moe.unitypackage", 20);
    t.db.prepare("UPDATE assets SET index_state='done' WHERE id=?").run(a);
    const r = await analyzeItemStructure(repo, itemId);
    assert.equal(r.errors.length, 0);
    const units = unitsOf();
    assert.equal(units.length, 1, "单个包不额外造容器单元");
    assert.equal(units[0].policy, "mixed_unitypackage");
    assert.equal(units[0].importable, 1);
    assert.equal(units[0].rel_path, "Manuka_and_Moe.unitypackage");
  });

  test("解析失败/未解析 → unknown_structure + failed，不伪造成功；重复分析幂等", async () => {
    const p = file("broken.zip");
    const a = archive(p, { index_state: "failed", index_error: "7z: corrupted" });
    const r = await analyzeItemStructure(repo, itemId);
    assert.ok(r.errors.length === 0, "解析失败体现在单元状态，不应抛错");
    let units = unitsOf();
    assert.equal(units.length, 1);
    assert.equal(units[0].policy, "unknown_structure");
    assert.equal(units[0].importable, 0);
    assert.equal(units[0].parse_state, "failed");
    assert.match(String(units[0].parse_error), /corrupted/);
    const again = await analyzeItemStructure(repo, itemId);
    units = unitsOf();
    assert.equal(units.length, 1, "幂等：重复分析不重复造单元");
    assert.equal(again.units, 1);
    void a;
  });
  test("嵌套容器：outer.zip → inner.zip → 2 个 upkg，depth≤2 发现且 rel_path='outer::inner'", async () => {
    const inner = join(dir, "inner.zip");
    execFileSync(path7za, ["a", "-tzip", "-bd", inner, "A.unitypackage", "B.unitypackage"], { cwd: makeZipDir({ "A.unitypackage": Buffer.alloc(5), "B.unitypackage": Buffer.alloc(6) }) });
    const outer = join(dir, "outer.zip");
    execFileSync(path7za, ["a", "-tzip", "-bd", outer, "inner.zip"], { cwd: makeZipDir({ "inner.zip": readFileSync(inner) }) });
    const a = archive(outer);
    const size = statSync(outer).size;
    t.db.prepare("UPDATE assets SET size=? WHERE id=?").run(size, a);
    t.db.prepare("INSERT INTO archive_entries(asset_id,entry_path,entry_size,is_dir,ext) VALUES (?,?,?,0,'.zip')").run(a, "inner.zip", statSync(inner).size);
    t.db.prepare("UPDATE assets SET index_state='done' WHERE id=?").run(a);
    await analyzeItemStructure(repo, itemId);
    const units = unitsOf();
    const pkgs = units.filter((u) => u.importable === 1).map((u) => u.rel_path).sort();
    assert.deepEqual(pkgs, ["inner.zip::A.unitypackage", "inner.zip::B.unitypackage"]);
    const container = units.find((u) => u.rel_path === "");
    assert.ok(container);
    assert.equal(container.policy, "multi_package_container");
    // 计划仍指向原始外层整包，单元用 outer::inner 约定定位内层包
    const view = createImportPlan(repo, { unitIds: units.filter((u) => u.importable === 1).map((u) => Number(u.id)), projectPath: join(dir, "UnityProject") });
    assert.equal(view.items.length, 2);
    assert.ok(view.items.every((i: any) => i.path === outer), "plan.path 必须是原始外层整包");
    assert.ok(view.items.every((i: any) => String(i.rel_path).includes("::")));
  });

  test("嵌套深度 >2：不再展开，落 limited 单元且不伪造 importable", async () => {
    const deep = join(dir, "deep.zip");
    execFileSync(path7za, ["a", "-tzip", "-bd", deep, "C.unitypackage"], { cwd: makeZipDir({ "C.unitypackage": Buffer.alloc(4) }) });
    const inner = join(dir, "inner2.zip");
    execFileSync(path7za, ["a", "-tzip", "-bd", inner, "deep.zip"], { cwd: makeZipDir({ "deep.zip": readFileSync(deep) }) });
    const outer = join(dir, "outer2.zip");
    execFileSync(path7za, ["a", "-tzip", "-bd", outer, "inner2.zip"], { cwd: makeZipDir({ "inner2.zip": readFileSync(inner) }) });
    const a = archive(outer);
    t.db.prepare("UPDATE assets SET size=? WHERE id=?").run(statSync(outer).size, a);
    t.db.prepare("INSERT INTO archive_entries(asset_id,entry_path,entry_size,is_dir,ext) VALUES (?,?,?,0,'.zip')").run(a, "inner2.zip", statSync(inner).size);
    t.db.prepare("UPDATE assets SET index_state='done' WHERE id=?").run(a);
    await analyzeItemStructure(repo, itemId);
    const units = unitsOf();
    assert.equal(units.filter((u) => u.importable === 1).length, 0, "深度 3 的包不得成为可导入单元");
    const limited = units.find((u) => u.rel_path === "inner2.zip::deep.zip");
    assert.ok(limited, "应留下 limited 证据");
    assert.equal(limited.parse_state, "limited");
    assert.equal(limited.policy, "unknown_structure");
    assert.match(String(limited.parse_error), /深度/);
  });
});

/** 建一个临时 ZIP 工作目录：name → 文件内容。 */
function makeZipDir(contents: Record<string, string | Buffer>): string {
  const work = mkdtempSync(join(dir, "z-"));
  for (const [name, data] of Object.entries(contents)) writeFileSync(join(work, name), data as any);
  return work;
}

