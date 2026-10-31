/**
 * 可靠性批次 2（task-2）：导入计划绑定**实际物理源字节**。
 * 回归 1-7 见 .superpowers/sdd/reliability-20261031/task-2-brief.md。
 * 关键约束：只改磁盘（DB 元数据完全不动）必须阻断；同大小 + 恢复 mtime 的内部字节改动同样阻断；
 * 每 operation 每物理容器只哈希一次（确定性计数）；旧计划无快照显式阻断；作业真实入口再校验。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { path7za } from "7zip-bin";
import { openTempDb, addItem, addRoot, addAsset, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { normalizePath } from "../../packages/core/src/pathnorm";
import {
  analyzeItemStructure,
  assertPlanSourcesIntact, buildSourceSnapshot, compareSourceSnapshots, createImportPlan, createImportPlanBatch,
  executeImportPlan, getPlanView, precheckImportPlanWithRisk, SOURCE_SNAPSHOT_VERSION,
} from "../../apps/server/src/services/structure";
import * as structureModule from "../../apps/server/src/services/structure";

let t: TempDb; let repo: Repo; let rootId: number; let itemId: number; let dir: string; let project: string;
const MT = "2026-10-02T00:00:00.000Z";
const SHA = "0123456789abcdef";
let guidSeq = 0;

beforeEach(() => {
  t = openTempDb(); repo = new Repo(t.db); rootId = addRoot(t.db, "/lib"); itemId = addItem(t.db, { title: "源文件快照" });
  dir = mkdtempSync(join(tmpdir(), "av-snap-")); project = join(dir, "UnityProject");
});
afterEach(() => { t.close(); rmSync(dir, { recursive: true, force: true }); });

const FIX = join(process.cwd(), "test/fixtures/structure/out");
const zipDir = (files: Record<string, Buffer>) => {
  const d = mkdtempSync(join(dir, "zip-")); for (const [n, b] of Object.entries(files)) writeFileSync(join(d, n), b); return d;
};

/** 真实 tmp 文件 + tmp DB：资产行大小/mtime/sha 与单元指纹互相对齐（未变化时不应误报指纹变化）。 */
function addUnit(opts: { path: string; relPath?: string; kind?: string; container?: string; unitSize?: number }) {
  const kind = opts.kind ?? "unitypackage";
  const container = opts.container ?? "unitypackage";
  const st = statSync(opts.path);
  const size = Number(st.size);
  const assetId = addAsset(t.db, itemId, rootId, opts.path, {
    kind, container, path: opts.path, path_norm: opts.path, size, mtime: MT, sha256: SHA,
  });
  // 直连包的包内路径入 DB：风险扫描不必重新解析（真实夹具包体除外）
  if (kind === "unitypackage") {
    guidSeq += 1;
    repo.replaceUnityPackageAssets(assetId, [{
      guid: String(guidSeq).padStart(32, "0"), assetPath: "Assets/Thing" + guidSeq + ".fbx", type: "Model", size: 1, hasPreview: false,
    }]);
  }
  const relPath = opts.relPath ?? "pkg.unitypackage";
  const unitSize = Number(opts.unitSize ?? size);
  const ids = repo.replaceAssetUnits(assetId, itemId, [{
    relPath, format: "unitypackage", kind: "unitypackage", name: "pkg", size: unitSize,
    fingerprint: unitSize + ":" + MT + ":" + SHA.slice(0, 8),
    policy: "single_unitypackage", importable: true, parseState: "ok", avatars: [], evidence: {},
  }]);
  return { assetId, unitId: ids.get(relPath)! };
}

/** 真实夹具容器复制到 tmp（绝不影响仓库夹具），返回容器路径。 */
function copyContainer(name: string): string {
  const dst = join(dir, name); copyFileSync(join(FIX, "D_companion.zip"), dst); return dst;
}

function countingUnity() {
  const unity: any = {
    endpoint: "fake", serverName: "fake", calls: 0,
    async csharp(_code: string) { unity.calls += 1; return ""; },
    async call() { unity.calls += 1; return { isError: false, text: "", structured: { data: [] } }; },
  };
  return unity;
}

describe("计划 ↔ 实际物理源字节", () => {
  test("1. 只改磁盘内容（DB 完全未动）→ 预检阻断，旧快照不被更新", async () => {
    const pkg = join(dir, "a.unitypackage"); writeFileSync(pkg, Buffer.alloc(64, 1));
    const { unitId } = addUnit({ path: pkg });
    const view = await createImportPlan(repo, { unitIds: [unitId], projectPath: project });
    assert.equal(view.plan.status, "ready", JSON.stringify(view.precheck));
    const stored = JSON.parse(view.plan.source_snapshot_json);
    assert.equal(stored.version, SOURCE_SNAPSHOT_VERSION);
    assert.equal(stored.algorithm, "sha256-full");
    assert.equal(stored.containers.length, 1);
    assert.match(String(stored.containers[0].sha256), /^[0-9a-f]{64}$/, "完整 64 位内容摘要，不是 DB 截断 sha");
    // 必修 2：索引不可信（此处 sha256 只有 16 位）时必须显式登记残余，不能伪称"证明与索引一致"
    assert.match(view.precheck.warnings.join("；"), /没有完整可信索引摘要/, "无可信索引时 warnings 必须显式登记残余");
    await assert.doesNotReject(precheckImportPlanWithRisk(repo, view.plan.id));
    assert.equal(repo.getImportPlan(view.plan.id).status, "ready", "未变化时预检不应改状态");

    writeFileSync(pkg, Buffer.alloc(64, 2)); // 只有磁盘变：DB 资产/单元指纹一律未动
    await assert.rejects(precheckImportPlanWithRisk(repo, view.plan.id),
      (e: any) => e.code === "SOURCE_CHANGED" && /物理快照/.test(e.message));
    const after = getPlanView(repo, view.plan.id)!;
    assert.equal(after.plan.status, "blocked");
    assert.equal(after.plan.source_snapshot_json, view.plan.source_snapshot_json, "旧快照必须保持不可变");
    assert.equal(repo.getAsset(Number(after.items[0].asset_id))!.sha256, SHA, "DB 字段未被测试改动");
  });

  test("2. 同字节长度 + 恢复 mtime 的内部字节改动 → 仍阻断（全内容摘要）", async () => {
    const pkg = join(dir, "b.unitypackage");
    const original = Buffer.alloc(96, 1); writeFileSync(pkg, original);
    // 固定到整数秒 mtime，避免 utimes 回写时的亚毫秒舍入干扰"元数据未变"的证明
    const fixed = new Date(MT);
    utimesSync(pkg, fixed, fixed);
    const st0 = statSync(pkg);
    const { unitId } = addUnit({ path: pkg });
    const view = await createImportPlan(repo, { unitIds: [unitId], projectPath: project });
    assert.equal(view.plan.status, "ready");

    const mutated = Buffer.from(original); mutated[48] = 0x7f; // 中间字节
    writeFileSync(pkg, mutated);
    utimesSync(pkg, fixed, fixed);
    const st1 = statSync(pkg);
    assert.equal(st1.size, st0.size);
    assert.equal(st1.mtimeMs, st0.mtimeMs, "size/mtime 必须保持一致（证明不是元数据变化被发现）");

    await assert.rejects(precheckImportPlanWithRisk(repo, view.plan.id),
      (e: any) => e.code === "SOURCE_CHANGED" && /物理快照/.test(e.message));
    assert.equal(repo.getImportPlan(view.plan.id).status, "blocked");
  });

  test("3. 容器单元源文件缺失 → 在任何 Unity/暂存副作用之前失败（暂存前，非空断言）", async () => {
    const zip = copyContainer("c.zip");
    const { unitId } = addUnit({ path: zip, kind: "archive", container: "zip", relPath: "MANUKA_model/MANUKA_model.unitypackage", unitSize: 33 });
    const view = await createImportPlan(repo, { unitIds: [unitId], projectPath: project });
    assert.equal(view.plan.status, "ready", JSON.stringify(view.precheck));
    rmSync(zip);

    const unity = countingUnity();
    const staging = join(dir, "staging");
    await assert.rejects(executeImportPlan({ repo, unity, stagingDir: staging, waitMs: 0 }, view.plan.id),
      (e: any) => e.code === "SOURCE_UNAVAILABLE" && /不可读/.test(e.message));
    assert.equal(unity.calls, 0, "Unity 不得被调用");
    assert.equal(existsSync(staging), false, "容器单元若进入暂存会 mkdir → 未创建即证明预检先于暂存");
    assert.equal(repo.getImportPlan(view.plan.id).status, "blocked");
    // 质量项：blocked 时保留原 units 诊断，不整列覆写 precheck_json
    const pj = JSON.parse(String(repo.getImportPlan(view.plan.id).precheck_json));
    assert.ok(Array.isArray(pj.units) && pj.units.length === 1, "blocked precheck_json 必须保留原 units 诊断");
    assert.equal(pj.sourceSnapshot.state, "SOURCE_UNAVAILABLE");
  });

  test("4. 未变化的直连包与容器内单元都可通过；容器单元 rel_path 被绑定", async () => {
    const pkg = join(dir, "d.unitypackage"); writeFileSync(pkg, Buffer.alloc(40, 4));
    const zip = copyContainer("d.zip");
    const direct = addUnit({ path: pkg });
    const packed = addUnit({ path: zip, kind: "archive", container: "zip", relPath: "MANUKA_model/MANUKA_model.unitypackage", unitSize: 33 });

    const v1 = await createImportPlan(repo, { unitIds: [direct.unitId], projectPath: project });
    assert.equal(v1.plan.status, "ready", JSON.stringify(v1.precheck));
    await assert.doesNotReject(precheckImportPlanWithRisk(repo, v1.plan.id));

    const v2 = await createImportPlan(repo, { unitIds: [packed.unitId], projectPath: project });
    assert.equal(v2.plan.status, "ready", JSON.stringify(v2.precheck));
    const snap = JSON.parse(v2.plan.source_snapshot_json);
    assert.equal(snap.containers.length, 1, "容器内单元绑定到真实容器文件");
    assert.equal(snap.units[0].relPath, "MANUKA_model/MANUKA_model.unitypackage");
    await assert.doesNotReject(assertPlanSourcesIntact(repo, v2.plan.id), "容器内单元未变化时物理快照一致");
  });

  test("5. 一个操作内同一物理容器只哈希一次（确定性计数，非性能基准）", async () => {
    const zip = join(FIX, "A_multi_container.zip");
    const st = statSync(zip);
    const assetId = addAsset(t.db, itemId, rootId, zip, { kind: "archive", container: "zip", path: zip, path_norm: zip, size: Number(st.size), mtime: MT, sha256: SHA });
    const rels = ["x/a.unitypackage", "x/b.unitypackage"];
    const ids = repo.replaceAssetUnits(assetId, itemId, rels.map((relPath) => ({
      relPath, format: "unitypackage", kind: "unitypackage", name: relPath, size: 33,
      fingerprint: "33:" + MT + ":" + SHA.slice(0, 8), policy: "single_unitypackage", importable: true,
      parseState: "ok", avatars: [], evidence: {},
    })));
    const view = await createImportPlan(repo, { unitIds: rels.map((r) => ids.get(r)!), projectPath: project });
    const snap = JSON.parse(view.plan.source_snapshot_json);
    assert.equal(snap.units.length, 2);
    assert.equal(snap.containers.length, 1, "两个单元共享物理容器 → 快照只记录一个容器");

    const hashed: string[] = [];
    const current = await buildSourceSnapshot(repo, view.plan.id, { onContainerHash: (p) => hashed.push(p) });
    assert.deepEqual(hashed, [normalizePath(zip)], "每容器恰好哈希一次");
    assert.equal(current.containers.length, 1);
    assert.equal(current.units.length, 2);
    assert.equal(compareSourceSnapshots(snap, current).ok, true);
  });

  test("6. 旧计划缺少物理快照 → 显式安全阻断，不静默补写/不偷换信任", async () => {
    const pkg = join(dir, "f.unitypackage"); writeFileSync(pkg, Buffer.alloc(24, 6));
    const { unitId } = addUnit({ path: pkg });
    const view = await createImportPlan(repo, { unitIds: [unitId], projectPath: project });
    assert.ok(view.plan.source_snapshot_json);
    // 模拟升级前建立的旧计划：该列不存在/为空（不是用改 DB 模拟"磁盘变化"这条主回归）
    t.db.prepare("UPDATE import_plans SET source_snapshot_json=NULL WHERE id=?").run(view.plan.id);

    await assert.rejects(precheckImportPlanWithRisk(repo, view.plan.id),
      (e: any) => e.code === "SNAPSHOT_MISSING" && /重新创建计划/.test(e.message));
    const after = getPlanView(repo, view.plan.id)!;
    assert.equal(after.plan.status, "blocked");
    assert.equal(after.plan.source_snapshot_json, null, "不得自动补写快照");
  });

  test("7. 请求期预检通过后磁盘被改：排队作业的真实入口在 Unity 前阻断（容器单元证明暂存前）", async () => {
    const zip = copyContainer("g.zip");
    const { unitId } = addUnit({ path: zip, kind: "archive", container: "zip", relPath: "MANUKA_model/MANUKA_model.unitypackage", unitSize: 33 });
    const view = await createImportPlan(repo, { unitIds: [unitId], projectPath: project });
    assert.equal(view.plan.status, "ready", JSON.stringify(view.precheck));
    await assert.doesNotReject(precheckImportPlanWithRisk(repo, view.plan.id), "请求期预检通过");

    writeFileSync(zip, Buffer.concat([readFileSync(zip), Buffer.from([0])])); // 排队后变化（DB 未动）
    const unity = countingUnity();
    const staging = join(dir, "staging");
    await assert.rejects(executeImportPlan({ repo, unity, stagingDir: staging, waitMs: 0 }, view.plan.id),
      (e: any) => e.code === "SOURCE_CHANGED");
    assert.equal(unity.calls, 0, "作业真实入口必须在 Unity 之前阻断");
    assert.equal(existsSync(staging), false, "容器单元在暂存前即被阻断");
    assert.equal(repo.getImportPlan(view.plan.id).status, "blocked");
  });

  test("8. 建计划前磁盘已变（索引后替换）：SOURCE_INDEX_STALE 阻断，不把新字节绑定旧索引", async () => {
    const pkg = join(dir, "h.unitypackage");
    const indexed = Buffer.alloc(80, 9); writeFileSync(pkg, indexed);
    const { unitId, assetId } = addUnit({ path: pkg });
    // 可信索引：sha256_state=ok + 完整 64 hex + size 与索引一致
    const idxSha = createHash("sha256").update(indexed).digest("hex");
    t.db.prepare("UPDATE assets SET sha256=?, sha256_state='ok' WHERE id=?").run(idxSha, assetId);

    // 索引之后、建计划之前替换磁盘；DB 完全未动
    const replacedDisk = Buffer.alloc(80, 10); writeFileSync(pkg, replacedDisk);
    const view = await createImportPlan(repo, { unitIds: [unitId], projectPath: project });

    assert.equal(view.plan.status, "blocked", "建计划前磁盘已漂移必须阻断（不能 ready 后再靠预检）");
    const item = view.items.find((i: any) => Number(i.unit_id) === unitId)!;
    assert.equal(item.status, "blocked");
    assert.match(String(item.error), /SOURCE_INDEX_STALE/, "错误码必须显式");
    assert.match(view.precheck.warnings.join("；"), /SOURCE_INDEX_STALE/);
    const snap = JSON.parse(view.plan.source_snapshot_json);
    assert.match(String(snap.containers[0].sha256), /^[0-9a-f]{64}$/);
    assert.notEqual(snap.containers[0].sha256, idxSha, "快照记录真实磁盘字节，但绝不能被当作与索引一致");
    // 即使磁盘内容此后不再变化，计划也不可执行（blocked 状态先于源校验生效）
    const unity = countingUnity();
    await assert.rejects(executeImportPlan({ repo, unity, stagingDir: join(dir, "staging"), waitMs: 0 }, view.plan.id),
      (e: any) => e.code === "PLAN_BLOCKED");
    assert.equal(unity.calls, 0);
  });

  test("9. 建计划路径异步（机械契约：Promise 返回 + 无同步快照构造器；非性能基准）", async () => {
    const pkg = join(dir, "i.unitypackage"); writeFileSync(pkg, Buffer.alloc(64, 11));
    const { unitId } = addUnit({ path: pkg });
    const pending: any = createImportPlan(repo, { unitIds: [unitId], projectPath: project });
    assert.ok(pending && typeof pending.then === "function", "createImportPlan 必须返回 Promise（不得同步全文件哈希）");
    const view = await pending;
    assert.equal(view.plan.status, "ready");
    // 同步快照构造器必须已删除（存在即证明建计划可同步读完整文件、饿死事件循环）
    assert.equal((structureModule as any).buildSourceSnapshotSync, undefined, "不得保留同步 buildSourceSnapshotSync");
    // 批量入口同样异步
    const batch: any = createImportPlanBatch(repo, { unitIds: [unitId], projectPath: project });
    assert.ok(batch && typeof batch.then === "function", "createImportPlanBatch 必须返回 Promise");
    const done = await batch;
    assert.equal(done.single, true);
  });

  test("10. outer::inner 嵌套单元：快照/预检绑定最外层容器，容器变即阻断", async () => {
    const realUpkg = readFileSync(join(FIX, "B_mixed.unitypackage"));
    const inner = join(dir, "inner.zip");
    execFileSync(path7za, ["a", "-tzip", "-bd", inner, "A.unitypackage"], { cwd: zipDir({ "A.unitypackage": realUpkg }) });
    const outer = join(dir, "outer.zip");
    execFileSync(path7za, ["a", "-tzip", "-bd", outer, "inner.zip"], { cwd: zipDir({ "inner.zip": readFileSync(inner) }) });
    const st = statSync(outer);
    const a = addAsset(t.db, itemId, rootId, outer, { kind: "archive", container: "zip", path: outer, path_norm: outer, size: Number(st.size), mtime: MT, sha256: SHA });
    t.db.prepare("INSERT INTO archive_entries(asset_id,entry_path,entry_size,is_dir,ext) VALUES (?,?,?,0,'.zip')").run(a, "inner.zip", statSync(inner).size);
    t.db.prepare("UPDATE assets SET index_state='done' WHERE id=?").run(a);
    await analyzeItemStructure(repo, itemId);
    const pkgs = repo.listUnits({ itemId }).filter((u: any) => Number(u.asset_id) === a && u.importable === 1);
    assert.ok(pkgs.length >= 1, "嵌套外层包内 upkg 必须被发现");
    assert.ok(pkgs.every((u: any) => String(u.rel_path).includes("::")), "rel_path 用 outer::inner 约定");

    const view = await createImportPlan(repo, { unitIds: pkgs.map((u: any) => Number(u.id)), projectPath: project });
    assert.ok(["ready", "needs_confirmation"].includes(String(view.plan.status)), JSON.stringify(view.precheck));
    const snap = JSON.parse(view.plan.source_snapshot_json);
    assert.equal(snap.containers.length, 1, "嵌套单元只绑定最外层物理容器");
    assert.equal(normalizePath(snap.containers[0].path), normalizePath(outer));
    assert.deepEqual(snap.units.map((u: any) => u.containerPath), pkgs.map(() => normalizePath(outer)));
    await assert.doesNotReject(assertPlanSourcesIntact(repo, view.plan.id), "嵌套单元未变化时快照一致");

    writeFileSync(outer, Buffer.concat([readFileSync(outer), Buffer.from([0])])); // 只改最外层磁盘
    await assert.rejects(assertPlanSourcesIntact(repo, view.plan.id),
      (e: any) => e.code === "SOURCE_CHANGED" && /物理快照/.test(e.message));
    assert.equal(repo.getImportPlan(view.plan.id).status, "blocked");
  });
});
