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
import { fileURLToPath } from "node:url";
import { openTempDb, addItem, addRoot, addAsset, addAvatar, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { analyzeItemStructure, createImportPlan } from "../../apps/server/src/services/structure";

const FIX = fileURLToPath(new URL("../fixtures/structure/out/", import.meta.url));
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
    const p = join(FIX, "A_multi_container.zip");
    const a = archive(p, { size: statSync(p).size });
    t.db.prepare("INSERT INTO archive_entries(asset_id,entry_path,entry_size,is_dir,ext) VALUES (?,?,?,0,'.unitypackage')").run(a, "MANUKA_clothing/MANUKA.unitypackage", 100);
    t.db.prepare("INSERT INTO archive_entries(asset_id,entry_path,entry_size,is_dir,ext) VALUES (?,?,?,0,'.unitypackage')").run(a, "OTHER_AVATAR/Kikyo.unitypackage", 100);
    addAvatar(t.db, "Manuka"); addAvatar(t.db, "Kikyo");
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
    const p = join(FIX, "C_container_mixed.zip");
    const a = archive(p, { size: statSync(p).size });
    addAvatar(t.db, "Manuka"); addAvatar(t.db, "Kikyo");
    t.db.prepare("INSERT INTO archive_entries(asset_id,entry_path,entry_size,is_dir,ext) VALUES (?,?,?,0,'.unitypackage')").run(a, "packages/B_mixed.unitypackage", 100);
    t.db.prepare("UPDATE assets SET index_state='done' WHERE id=?").run(a);
    const r = await analyzeItemStructure(repo, itemId);
    assert.equal(r.errors.length, 0);
    const units = unitsOf();
    assert.equal(units.length, 1, "单个包不额外造容器单元");
    assert.equal(units[0].policy, "mixed_unitypackage");
    assert.equal(units[0].importable, 1);
    assert.equal(units[0].rel_path, "packages/B_mixed.unitypackage");
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
    const realUpkg = readFileSync(join(FIX, "B_mixed.unitypackage"));
    execFileSync(path7za, ["a", "-tzip", "-bd", inner, "A.unitypackage", "B.unitypackage"], { cwd: makeZipDir({ "A.unitypackage": realUpkg, "B.unitypackage": realUpkg }) });
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

  test("task-45：depth3 的 upkg（outer::inner1::inner2::pkg）能发现并解析包内路径", async () => {
    const deep = join(dir, "deep3.zip");
    execFileSync(path7za, ["a", "-tzip", "-bd", deep, "C.unitypackage"], { cwd: makeZipDir({ "C.unitypackage": readFileSync(join(FIX, "B_mixed.unitypackage")) }) });
    const inner = join(dir, "inner3.zip");
    execFileSync(path7za, ["a", "-tzip", "-bd", inner, "deep3.zip"], { cwd: makeZipDir({ "deep3.zip": readFileSync(deep) }) });
    const outer = join(dir, "outer3.zip");
    execFileSync(path7za, ["a", "-tzip", "-bd", outer, "inner3.zip"], { cwd: makeZipDir({ "inner3.zip": readFileSync(inner) }) });
    const a = archive(outer);
    t.db.prepare("UPDATE assets SET size=? WHERE id=?").run(statSync(outer).size, a);
    t.db.prepare("INSERT INTO archive_entries(asset_id,entry_path,entry_size,is_dir,ext) VALUES (?,?,?,0,'.zip')").run(a, "inner3.zip", statSync(inner).size);
    t.db.prepare("UPDATE assets SET index_state='done' WHERE id=?").run(a);
    addAvatar(t.db, "Manuka"); addAvatar(t.db, "Kikyo");
    await analyzeItemStructure(repo, itemId);
    const pkg = unitsOf().find((u) => u.importable === 1);
    assert.ok(pkg, "depth3 的 upkg 必须被发现");
    assert.equal(pkg.rel_path, "inner3.zip::deep3.zip::C.unitypackage");
    assert.ok(pkg.rel_path.split("::").length >= 3);
    assert.equal(pkg.policy, "mixed_unitypackage", "包内路径解析后按内容判 mixed");
    const ev = JSON.parse(pkg.avatar_json);
    assert.ok(ev.some((x: any) => x.level === "probable"));
    // 计划仍指向原始外层整包
    const view = createImportPlan(repo, { unitIds: [Number(pkg.id)], projectPath: join(dir, "UnityProject") });
    assert.equal(view.items[0].path, outer);
  });

  test("task-45：depth4 停止展开，落 limited 且不伪造 importable", async () => {
    const lvl5 = join(dir, "deeper2.zip");
    execFileSync(path7za, ["a", "-tzip", "-bd", lvl5, "C.unitypackage"], { cwd: makeZipDir({ "C.unitypackage": Buffer.alloc(4) }) });
    const deepest = join(dir, "deeper.zip");
    execFileSync(path7za, ["a", "-tzip", "-bd", deepest, "deeper2.zip"], { cwd: makeZipDir({ "deeper2.zip": readFileSync(lvl5) }) });
    const deep = join(dir, "deep4.zip");
    execFileSync(path7za, ["a", "-tzip", "-bd", deep, "deeper.zip"], { cwd: makeZipDir({ "deeper.zip": readFileSync(deepest) }) });
    const inner = join(dir, "inner4.zip");
    execFileSync(path7za, ["a", "-tzip", "-bd", inner, "deep4.zip"], { cwd: makeZipDir({ "deep4.zip": readFileSync(deep) }) });
    const outer = join(dir, "outer4.zip");
    execFileSync(path7za, ["a", "-tzip", "-bd", outer, "inner4.zip"], { cwd: makeZipDir({ "inner4.zip": readFileSync(inner) }) });
    const a = archive(outer);
    t.db.prepare("UPDATE assets SET size=? WHERE id=?").run(statSync(outer).size, a);
    t.db.prepare("INSERT INTO archive_entries(asset_id,entry_path,entry_size,is_dir,ext) VALUES (?,?,?,0,'.zip')").run(a, "inner4.zip", statSync(inner).size);
    t.db.prepare("UPDATE assets SET index_state='done' WHERE id=?").run(a);
    await analyzeItemStructure(repo, itemId);
    const units = unitsOf();
    assert.equal(units.filter((u) => u.importable === 1).length, 0, "depth4 的包不得成为可导入单元");
    const limited = units.find((u) => String(u.rel_path).endsWith("deeper2.zip"));
    assert.ok(limited, "应留下 limited 证据");
    assert.equal(limited.parse_state, "limited");
    assert.equal(limited.policy, "unknown_structure");
    assert.match(String(limited.parse_error), /深度/);
  });
  test("task-44：item_avatars 的 auto 匹配不算 confirmed，manual/confirmed 才算", async () => {
    const p = join(dir, "avatar-rule.unitypackage"); writeFileSync(p, readFileSync(join(FIX, "B_mixed.unitypackage")));
    const a = upkg(p, { size: statSync(p).size, mtime: "2026-10-01T00:00:00.000Z" });
    t.db.prepare("UPDATE assets SET index_state='done' WHERE id=?").run(a);
    const manuka = addAvatar(t.db, "Manuka"); const kikyo = addAvatar(t.db, "Kikyo");
    t.db.prepare("INSERT INTO item_avatars(item_id,avatar_id,match,confidence,source) VALUES (?,?,'any',0.9,'auto')").run(itemId, kikyo);
    assert.deepEqual(repo.itemAvatarIds(itemId), [], "auto 不得进 confirmed 证据");
    await analyzeItemStructure(repo, itemId);
    let ev = JSON.parse(unitsOf()[0].avatar_json);
    assert.ok(ev.every((x: any) => x.avatarId !== kikyo || x.level !== "confirmed"), "auto 匹配不能是 confirmed");
    // manual（Kikyo）+ match=confirmed（Manuka）才进 confirmed
    t.db.prepare("UPDATE item_avatars SET source='manual' WHERE item_id=? AND avatar_id=?").run(itemId, kikyo);
    t.db.prepare("INSERT INTO item_avatars(item_id,avatar_id,match,confidence,source) VALUES (?,?,'confirmed',1,'auto')").run(itemId, manuka);
    assert.deepEqual(repo.itemAvatarIds(itemId).sort(), [manuka, kikyo].sort());
    await analyzeItemStructure(repo, itemId);
    ev = JSON.parse(unitsOf()[0].avatar_json);
    assert.equal(ev.find((x: any) => x.avatarId === kikyo)?.level, "confirmed");
    assert.equal(ev.find((x: any) => x.avatarId === manuka)?.level, "confirmed");
  });

  test("task-44：直连 upkg 无索引结果时按需解析包内路径 → mixed 判据与 probable 证据", async () => {
    const p = join(FIX, "B_mixed.unitypackage");
    const a = upkg(p, { size: statSync(p).size, mtime: "2026-10-01T00:00:00.000Z" });
    t.db.prepare("UPDATE assets SET index_state='done' WHERE id=?").run(a);
    addAvatar(t.db, "Manuka"); addAvatar(t.db, "Kikyo");
    await analyzeItemStructure(repo, itemId);
    const u = unitsOf()[0];
    assert.equal(u.policy, "mixed_unitypackage", "包内路径含 2 个 avatar → mixed");
    assert.equal(u.importable, 1);
    const ev = JSON.parse(u.avatar_json);
    assert.ok(ev.length >= 2);
    assert.ok(ev.every((x: any) => x.level === "probable"), "包内路径只给 probable");
    const evidence = JSON.parse(u.evidence_json ?? "{}");
    assert.equal(evidence.contentParsed, true);
    assert.ok(Number(evidence.packagePaths) >= 2);
  });

  test("task-44：outer::inner 嵌套包也解析包内路径（不靠文件名）", async () => {
    const mid = join(FIX, "C_container_mixed.zip");
    const outer = join(dir, "outer-nested.zip");
    execFileSync(path7za, ["a", "-tzip", "-bd", outer, "C_container_mixed.zip"], { cwd: makeZipDir({ "C_container_mixed.zip": readFileSync(mid) }) });
    const a = archive(outer);
    t.db.prepare("UPDATE assets SET size=? WHERE id=?").run(statSync(outer).size, a);
    t.db.prepare("INSERT INTO archive_entries(asset_id,entry_path,entry_size,is_dir,ext) VALUES (?,?,?,0,'.zip')").run(a, "C_container_mixed.zip", statSync(mid).size);
    t.db.prepare("UPDATE assets SET index_state='done' WHERE id=?").run(a);
    addAvatar(t.db, "Manuka"); addAvatar(t.db, "Kikyo");
    await analyzeItemStructure(repo, itemId);
    const pkg = unitsOf().find((u) => u.rel_path.includes("::") && u.importable === 1);
    assert.ok(pkg, "嵌套包应可导入");
    assert.equal(pkg.policy, "mixed_unitypackage");
    const ev = JSON.parse(pkg.avatar_json);
    assert.ok(ev.some((x: any) => x.level === "probable" && /Assets\//.test(String((x.hits ?? []).join(" ")))), "证据必须来自包内路径");
  });

  test("task-44：损坏/截断 upkg 解析失败 → limited/failed、unknown、不可导入", async () => {
    const p = join(FIX, "E2_truncated.unitypackage");
    const a = upkg(p, { size: statSync(p).size, mtime: "2026-10-01T00:00:00.000Z" });
    t.db.prepare("UPDATE assets SET index_state='done' WHERE id=?").run(a);
    await analyzeItemStructure(repo, itemId);
    const u = unitsOf()[0];
    assert.ok(["limited", "failed"].includes(u.parse_state));
    assert.equal(u.policy, "unknown_structure");
    assert.equal(u.importable, 0);
    assert.match(String(u.parse_error), /解析 unitypackage 内容失败/);
  });
});


/** 建一个临时 ZIP 工作目录：name → 文件内容。 */
function makeZipDir(contents: Record<string, string | Buffer>): string {
  const work = mkdtempSync(join(dir, "z-"));
  for (const [name, data] of Object.entries(contents)) writeFileSync(join(work, name), data as any);
  return work;
}

