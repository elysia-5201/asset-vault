/**
 * T1 纯核心：前置条件（注入 execFile/access，闭网；不主动连接 Unity）。
 * 口径：顺序固定；无 Editor 信息 = unknown（不伪 ok）；错工程 = mismatch；缺失 = missing。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPrerequisites } from "../../apps/server/src/services/unity-install-core";

function makeProject(root: string): string {
  const project = join(root, "My Project");
  mkdirSync(join(project, "Packages"), { recursive: true });
  mkdirSync(join(project, "ProjectSettings"), { recursive: true });
  writeFileSync(join(project, "Packages", "manifest.json"), '{\n  "dependencies": {}\n}\n');
  writeFileSync(join(project, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 2021.3.22f1\n");
  return project;
}

test("前置条件：顺序固定、无 Editor 为 unknown、匹配为 ok、错工程为 mismatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-prereq-"));
  try {
    const project = makeProject(root);
    const noEditor = await checkPrerequisites({ projectPath: project, unityVersion: "2021.3.22f1", execFile: async () => ({ stdout: "ok" }), access: async () => {} });
    assert.deepEqual(noEditor.map((x) => x.id), ["unity_version", "uv", "git", "writable", "editor"]);
    assert.deepEqual(noEditor.map((x) => x.status), ["ok", "ok", "ok", "ok", "unknown"]);
    assert.ok(noEditor.every((x) => typeof x.detail === "string" && x.detail.length > 0));

    const matched = await checkPrerequisites({ projectPath: project, unityVersion: "2021.3.22f1", editorProjectPath: project, execFile: async () => ({ stdout: "ok" }), access: async () => {} });
    assert.equal(matched.find((x) => x.id === "editor")?.status, "ok");

    const missing = await checkPrerequisites({ projectPath: project, unityVersion: "2021.3.22f1", execFile: async (f) => { if (f === "uv") throw new Error("missing"); return { stdout: "ok" }; }, access: async () => {} });
    assert.equal(missing.find((x) => x.id === "uv")?.status, "missing");

    const mismatch = await checkPrerequisites({ projectPath: project, unityVersion: "2021.3.22f1", editorProjectPath: "/other", execFile: async () => ({ stdout: "ok" }), access: async () => {} });
    assert.equal(mismatch.find((x) => x.id === "editor")?.status, "mismatch");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("前置条件：版本不支持/缺 git/不可写 = missing；execFile 只用固定参数", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-prereq-"));
  try {
    const project = makeProject(root);
    const calls: Array<[string, string[]]> = [];
    const ok = await checkPrerequisites({ projectPath: project, unityVersion: "2021.3.22f1", execFile: async (f, a) => { calls.push([f, a]); return { stdout: "ok" }; }, access: async () => {} });
    assert.deepEqual(calls, [["uv", ["--version"]], ["git", ["--version"]]]);
    assert.equal(ok.find((x) => x.id === "editor")?.status, "unknown");

    const unsupported = await checkPrerequisites({ projectPath: project, unityVersion: "2020.3.48f1", execFile: async () => ({ stdout: "ok" }), access: async () => {} });
    assert.equal(unsupported.find((x) => x.id === "unity_version")?.status, "missing");

    const noGit = await checkPrerequisites({ projectPath: project, unityVersion: "2021.3.22f1", execFile: async (f) => { if (f === "git") throw new Error("no git"); return { stdout: "ok" }; }, access: async () => {} });
    assert.equal(noGit.find((x) => x.id === "git")?.status, "missing");

    const noWrite = await checkPrerequisites({ projectPath: project, unityVersion: "2021.3.22f1", execFile: async () => ({ stdout: "ok" }), access: async () => { throw new Error("EACCES"); } });
    assert.equal(noWrite.find((x) => x.id === "writable")?.status, "missing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("writable 双门：Packages 目录与 manifest 都必须可写（旧源反例）", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-prereq-"));
  try {
    const project = makeProject(root);
    const packagesDir = join(project, "Packages");
    const manifestPath = join(packagesDir, "manifest.json");
    const calls: string[] = [];

    // 旧源反例：manifest 可写、Packages 目录拒 → 必须 missing（旧实现只看 manifest 会误报 ok）
    const dirDenied = await checkPrerequisites({
      projectPath: project, unityVersion: "2021.3.22f1",
      execFile: async () => ({ stdout: "ok" }),
      access: async (p) => { calls.push(p); if (p === packagesDir) throw new Error("EACCES"); },
    });
    assert.equal(dirDenied.find((x) => x.id === "writable")?.status, "missing");
    assert.match(dirDenied.find((x) => x.id === "writable")?.detail ?? "", /Packages/);
    assert.deepEqual(calls, [packagesDir]);

    // 保守门保留：目录可写、manifest 拒 → missing
    const manifestDenied = await checkPrerequisites({
      projectPath: project, unityVersion: "2021.3.22f1",
      execFile: async () => ({ stdout: "ok" }),
      access: async (p) => { calls.push(p); if (p === manifestPath) throw new Error("EACCES"); },
    });
    assert.equal(manifestDenied.find((x) => x.id === "writable")?.status, "missing");
    assert.match(manifestDenied.find((x) => x.id === "writable")?.detail ?? "", /manifest/);

    // 双可写 → ok，且实际检查顺序为 Packages → manifest
    const bothOk = await checkPrerequisites({
      projectPath: project, unityVersion: "2021.3.22f1",
      execFile: async () => ({ stdout: "ok" }),
      access: async (p) => { calls.push(p); },
    });
    assert.equal(bothOk.find((x) => x.id === "writable")?.status, "ok");
    assert.deepEqual(calls.slice(-2), [packagesDir, manifestPath]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
