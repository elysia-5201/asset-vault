/**
 * T2 faults：stale、rollback conflict、坏 backup、lock 缺失、cancel、缺实体。
 * 真实自有 TMP 合成工程；不碰真实 Unity/生产。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreview, applyPreview, getOperation, rollbackOperation, cancelPreview, type UnityInstallDeps } from "../../apps/server/src/services/unity-install";
import { UNITY_MCP_PACKAGE_ID, UNITY_MCP_PACKAGE_URL } from "../../apps/server/src/services/unity-install-core";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function makeProject(root: string, opts: { version?: string; manifest?: string; lock?: string | null } = {}): string {
  const project = join(root, "Project");
  mkdirSync(join(project, "Packages"), { recursive: true });
  mkdirSync(join(project, "ProjectSettings"), { recursive: true });
  writeFileSync(join(project, "Packages", "manifest.json"), opts.manifest ?? '{\n  "dependencies": {}\n}\n');
  writeFileSync(join(project, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: " + (opts.version ?? "2021.3.22f1") + "\n");
  if (opts.lock !== null) writeFileSync(join(project, "Packages", "packages-lock.json"), opts.lock ?? '{\n  "dependencies": {}\n}\n');
  return project;
}

function deps(dataDir: string, overrides: Partial<UnityInstallDeps> = {}): UnityInstallDeps {
  return { dataDir, repo: { getSetting: () => null }, now: () => NOW, execFile: async () => ({ stdout: "ok" }), ...overrides };
}

test("preview 后 manifest 外改 -> apply 409 PREVIEW_STALE，零写", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-faults-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root);
    const manifestPath = join(project, "Packages", "manifest.json");
    const preview = await createPreview(deps(dataDir), project);
    const changed = '{\n  "dependencies": {\n    "x": "1"\n  }\n}\n';
    writeFileSync(manifestPath, changed);
    await assert.rejects(() => applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true }), (e: any) =>
      e.code === "CONFLICT" && e.details?.code === "UNITY_INSTALL_PREVIEW_STALE");
    assert.equal(readFileSync(manifestPath, "utf8"), changed);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rollback：当前 hash 不等于 afterHash -> 409 ROLLBACK_CONFLICT，带可显示 diff，不写", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-faults-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root);
    const manifestPath = join(project, "Packages", "manifest.json");
    const preview = await createPreview(deps(dataDir), project);
    const result = await applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true });
    const external = '{\n  "dependencies": {\n    "x": "1"\n  }\n}\n';
    writeFileSync(manifestPath, external);
    let err: any;
    assert.throws(() => rollbackOperation(deps(dataDir), result.operationId!), (e: any) => {
      err = e;
      return e.code === "CONFLICT" && e.details?.code === "UNITY_INSTALL_ROLLBACK_CONFLICT";
    });
    assert.equal(readFileSync(manifestPath, "utf8"), external);
    assert.equal(typeof err.details.diff, "string");
    assert.ok(err.details.diff.includes('-    "' + UNITY_MCP_PACKAGE_ID + '"'), "diff 必须含预期安装的目标行");
    assert.ok(err.details.diff.includes('+    "x": "1"'), "diff 必须含当前外改行");
    assert.ok(err.message.includes("差异（预期安装（after） vs 当前）"), "describeError 可见 diff 标题");
    assert.ok(err.message.includes('"x": "1"'), "describeError 可见外改行");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rollback：坏 backup hash -> 409 ROLLBACK_CONFLICT，差异不可用原因，不写", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-faults-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root);
    const manifestPath = join(project, "Packages", "manifest.json");
    const preview = await createPreview(deps(dataDir), project);
    const result = await applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true });
    const after = readFileSync(manifestPath);
    writeFileSync(join(result.backupDir!, "manifest.json"), "tampered");
    let err: any;
    assert.throws(() => rollbackOperation(deps(dataDir), result.operationId!), (e: any) => {
      err = e;
      return e.code === "CONFLICT" && e.details?.code === "UNITY_INSTALL_ROLLBACK_CONFLICT";
    });
    assert.equal(readFileSync(manifestPath).equals(after), true);
    assert.equal(err.details.diff, undefined);
    assert.match(String(err.details.diffUnavailable), /哈希不匹配/);
    assert.ok(err.message.includes("差异不可用：备份 manifest 哈希不匹配"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rollback：缺 backup -> 409 ROLLBACK_CONFLICT，差异不可用原因，不写", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-faults-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root);
    const manifestPath = join(project, "Packages", "manifest.json");
    const preview = await createPreview(deps(dataDir), project);
    const result = await applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true });
    rmSync(join(result.backupDir!, "manifest.json"));
    const external = '{\n  "dependencies": {\n    "x": "1"\n  }\n}\n';
    writeFileSync(manifestPath, external);
    let err: any;
    assert.throws(() => rollbackOperation(deps(dataDir), result.operationId!), (e: any) => {
      err = e;
      return e.code === "CONFLICT" && e.details?.code === "UNITY_INSTALL_ROLLBACK_CONFLICT";
    });
    assert.equal(readFileSync(manifestPath, "utf8"), external);
    assert.equal(err.details.diff, undefined);
    assert.match(String(err.details.diffUnavailable), /缺失/);
    assert.ok(err.message.includes("差异不可用：备份 manifest 缺失"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("lock 缺失：backup 不伪造 packages-lock，apply 仍成功", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-faults-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root, { lock: null });
    const preview = await createPreview(deps(dataDir), project);
    const result = await applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true });
    assert.equal(result.status, "config_applied");
    assert.equal(existsSync(join(result.backupDir!, "packages-lock.json")), false);
    const meta = JSON.parse(readFileSync(join(result.backupDir!, "meta.json"), "utf8"));
    assert.equal(meta.files.some((f: any) => f.name === "packages-lock.json"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cancel：未应用可取消并删 preview；取消后 apply 404", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-faults-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root);
    const preview = await createPreview(deps(dataDir), project);
    const file = join(dataDir, "unity-install", "previews", preview.previewId + ".json");
    assert.deepEqual(cancelPreview(deps(dataDir), preview.previewId), { cancelled: true });
    assert.equal(existsSync(file), false);
    await assert.rejects(() => applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true }), (e: any) =>
      e.code === "NOT_FOUND" && e.details?.code === "UNITY_INSTALL_NOT_FOUND");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cancel：已应用 -> 409 PREVIEW_STALE", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-faults-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root);
    const preview = await createPreview(deps(dataDir), project);
    await applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true });
    assert.throws(() => cancelPreview(deps(dataDir), preview.previewId), (e: any) =>
      e.code === "CONFLICT" && e.details?.code === "UNITY_INSTALL_PREVIEW_STALE");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("缺实体：getOperation/rollback/cancel 均 404 NOT_FOUND", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-faults-"));
  try {
    const dataDir = join(root, "data");
    const id = "00000000-0000-4000-8000-000000000000";
    assert.throws(() => getOperation(deps(dataDir), id), (e: any) => e.code === "NOT_FOUND" && e.details?.code === "UNITY_INSTALL_NOT_FOUND");
    assert.throws(() => rollbackOperation(deps(dataDir), id), (e: any) => e.code === "NOT_FOUND" && e.details?.code === "UNITY_INSTALL_NOT_FOUND");
    assert.throws(() => cancelPreview(deps(dataDir), id), (e: any) => e.code === "NOT_FOUND" && e.details?.code === "UNITY_INSTALL_NOT_FOUND");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("apply：confirm 非 true -> 400；非法 id -> 400 INVALID_ID", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-faults-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root);
    const preview = await createPreview(deps(dataDir), project);
    await assert.rejects(() => applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: false as any }), (e: any) =>
      e.code === "INVALID_INPUT" && e.details?.code === "UNITY_INSTALL_CONFLICT");
    await assert.rejects(() => applyPreview(deps(dataDir), { previewId: "../x", confirm: true }), (e: any) =>
      e.code === "INVALID_INPUT" && e.details?.code === "UNITY_INSTALL_INVALID_ID");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("backup：三份原字节同目录 temp+rename，不直接写 final", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-faults-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root);
    const manifestPath = join(project, "Packages", "manifest.json");
    const before = readFileSync(manifestPath);
    const writes: string[] = [];
    const renames: Array<{ from: string; to: string }> = [];
    const fs = {
      writeFileSync(p: any, d: any, o: any) {
        writes.push(String(p));
        return (realFs.writeFileSync as any)(p, d, o);
      },
      renameSync(from: any, to: any) {
        renames.push({ from: String(from), to: String(to) });
        return (realFs.renameSync as any)(from, to);
      },
    };
    const preview = await createPreview(deps(dataDir), project);
    const result = await applyPreview(deps(dataDir, { fs }), { previewId: preview.previewId, confirm: true });
    const backupDir = result.backupDir!;
    for (const name of ["manifest.json", "packages-lock.json", "ProjectVersion.txt"]) {
      const final = join(backupDir, name);
      assert.equal(writes.includes(final), false, name + " 不得直接写 final");
      const r = renames.find((x) => x.to === final);
      assert.ok(r, name + " 必须 rename 到 final");
      assert.ok(r!.from.startsWith(final + ".tmp-"), name + " temp 必须同目录");
    }
    assert.equal(readFileSync(join(backupDir, "manifest.json")).equals(before), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("backup：rename 失败 -> 409 BACKUP_FAILED，manifest 零写", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-faults-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root);
    const manifestPath = join(project, "Packages", "manifest.json");
    const before = readFileSync(manifestPath);
    const fs = {
      renameSync(from: any, to: any) {
        const target = String(to).replaceAll("\\", "/");
        if (target.includes("/unity-install/backups/") && target.endsWith("/manifest.json")) {
          throw new Error("backup rename fail");
        }
        return (realFs.renameSync as any)(from, to);
      },
    };
    const preview = await createPreview(deps(dataDir), project);
    await assert.rejects(() => applyPreview(deps(dataDir, { fs }), { previewId: preview.previewId, confirm: true }), (e: any) =>
      e.code === "CONFLICT" && e.details?.code === "UNITY_INSTALL_BACKUP_FAILED");
    assert.equal(readFileSync(manifestPath).equals(before), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
