/**
 * T2 journal：写前/写后 journal 失败与 recovery 三分支。
 * 真实自有 TMP 合成工程；fs 注入只用于故障点。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realFs from "node:fs";
import { createPreview, applyPreview, recoverInterruptedOperations, type UnityInstallDeps } from "../../apps/server/src/services/unity-install";
import { buildManifestText, UNITY_MCP_PACKAGE_ID, UNITY_MCP_PACKAGE_URL } from "../../apps/server/src/services/unity-install-core";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function makeProject(root: string, opts: { version?: string; manifest?: string; lock?: string | null } = {}, name = "Project"): string {
  const project = join(root, name);
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

test("写前 journal 失败：manifest 零写，错误 JOURNAL_FAILED", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-journal-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root);
    const manifestPath = join(project, "Packages", "manifest.json");
    const before = readFileSync(manifestPath);
    const preview = await createPreview(deps(dataDir), project);
    const fs = {
      writeFileSync(p: any, d: any, o: any) {
        if (String(p).replaceAll("\\", "/").includes("/operations/")) throw new Error("journal fail before manifest");
        return (realFs.writeFileSync as any)(p, d, o);
      },
    };
    await assert.rejects(() => applyPreview(deps(dataDir, { fs }), { previewId: preview.previewId, confirm: true }), (e: any) =>
      e.details?.code === "UNITY_INSTALL_JOURNAL_FAILED");
    assert.equal(readFileSync(manifestPath).equals(before), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("写后 journal 失败：真实 rename 成功、保留 backup、错误带 opid/backupDir/afterHash", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-journal-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root);
    const manifestPath = join(project, "Packages", "manifest.json");
    const before = readFileSync(manifestPath);
    const preview = await createPreview(deps(dataDir), project);
    let renamed = false;
    let journalCalls = 0;
    const fs = {
      renameSync(from: any, to: any) {
        (realFs.renameSync as any)(from, to);
        if (String(to) === manifestPath) renamed = true;
      },
      writeFileSync(p: any, d: any, o: any) {
        if (String(p).replaceAll("\\", "/").includes("/operations/")) {
          journalCalls++;
          if (renamed) throw new Error("journal fail after manifest rename");
        }
        return (realFs.writeFileSync as any)(p, d, o);
      },
    };
    let err: any;
    await assert.rejects(() => applyPreview(deps(dataDir, { fs }), { previewId: preview.previewId, confirm: true }), (e: any) => {
      err = e;
      return e.details?.code === "UNITY_INSTALL_JOURNAL_FAILED";
    });
    assert.equal(renamed, true);
    assert.ok(journalCalls > 0);
    const afterBytes = readFileSync(manifestPath);
    assert.equal(sha(afterBytes), err.details.afterHash);
    assert.equal(readFileSync(join(err.details.backupDir, "manifest.json")).equals(before), true);
    const op = JSON.parse(readFileSync(join(dataDir, "unity-install", "operations", err.details.operationId + ".json"), "utf8"));
    assert.equal(op.operationId, err.details.operationId);
    assert.equal(op.backupDir, err.details.backupDir);
    assert.equal(op.status, "applying");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recovery 三分支：原 manifest -> interrupted；外改 -> conflict；本次 after -> config_applied", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-journal-"));
  try {
    const dataDir = join(root, "data");
    const opsDir = join(dataDir, "unity-install", "operations");
    mkdirSync(opsDir, { recursive: true });
    const beforeText = '{\n  "dependencies": {}\n}\n';
    const afterText = buildManifestText(beforeText, UNITY_MCP_PACKAGE_ID, UNITY_MCP_PACKAGE_URL);
    const externalText = '{\n  "dependencies": {\n    "x": "1"\n  }\n}\n';
    const beforeHash = sha(beforeText);
    const afterHash = sha(afterText);
    const cases = [
      { id: "op-interrupted", manifest: beforeText, want: "interrupted", afterHash },
      { id: "op-conflict", manifest: externalText, want: "conflict", afterHash },
      // 写后 journal 失败/崩溃：afterHash 尚未落盘，只有 plannedAfterHash；recovery 必须按 planned 判 config_applied。
      { id: "op-applied", manifest: afterText, want: "config_applied", afterHash: null },
    ];
    for (const c of cases) {
      const project = makeProject(root, { manifest: c.manifest }, c.id);
      const op = {
        operationId: c.id, projectPath: project, projectPathNorm: project,
        packageId: UNITY_MCP_PACKAGE_ID, targetVersion: "10.0.0", targetUrl: UNITY_MCP_PACKAGE_URL,
        status: "applying", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
        beforeHash, afterHash: c.afterHash, plannedAfterHash: afterHash,
        backupDir: join(dataDir, "unity-install", "backups", c.id),
        steps: { config: "pending", upm: "pending", compile: "unknown", bridge: "unknown", tool: "unknown", server: "unknown" },
      };
      writeFileSync(join(opsDir, c.id + ".json"), JSON.stringify(op));
    }
    const result = await recoverInterruptedOperations({ dataDir, now: () => NOW });
    assert.deepEqual(result, { recovered: 2, conflicts: 1 });
    const readOp = (id: string) => JSON.parse(readFileSync(join(opsDir, id + ".json"), "utf8"));
    assert.equal(readOp("op-interrupted").status, "interrupted");
    assert.equal(readOp("op-conflict").status, "conflict");
    assert.equal(readOp("op-applied").status, "config_applied");
    assert.equal(readOp("op-applied").afterHash, afterHash, "recovery 必须把 plannedAfterHash 落成 afterHash");
    // 不自动回滚：三个 manifest 都保持调用前字节
    for (const c of cases) {
      assert.equal(readFileSync(join(root, c.id, "Packages", "manifest.json"), "utf8"), c.manifest);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
