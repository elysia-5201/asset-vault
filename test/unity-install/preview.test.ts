/**
 * T2 预览：createPreview 的 TTL/哈希/落盘/版本硬门/change 分类。
 * 真实自有 TMP 合成工程；不碰真实 Unity/生产。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreview, applyPreview, type UnityInstallDeps } from "../../apps/server/src/services/unity-install";
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

test("createPreview：add、TTL、previewHash、preview 落盘、manifest 不变", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-preview-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root);
    const manifestPath = join(project, "Packages", "manifest.json");
    const before = readFileSync(manifestPath);
    const preview = await createPreview(deps(dataDir), project);
    assert.equal(preview.expiresAt, "2026-11-05T12:10:00.000Z");
    assert.match(preview.previewHash, /^[0-9a-f]{64}$/);
    assert.equal(preview.package.change, "add");
    assert.equal(preview.package.id, UNITY_MCP_PACKAGE_ID);
    assert.equal(preview.package.targetUrl, UNITY_MCP_PACKAGE_URL);
    assert.equal(preview.project.manifestHash, sha(before));
    assert.ok(preview.diff.includes("+"));
    assert.equal(existsSync(join(dataDir, "unity-install", "previews", preview.previewId + ".json")), true);
    assert.equal(readFileSync(manifestPath).equals(before), true);
    assert.deepEqual(preview.prerequisites.map((p) => p.id), ["unity_version", "uv", "git", "writable", "editor"]);
    assert.equal(preview.prerequisites.find((p) => p.id === "editor")?.status, "unknown");
    assert.ok(preview.warnings.some((w) => w.includes("Editor")));
    assert.ok(preview.backup.files.some((f) => f.path === manifestPath && f.sha256 === sha(before)));
    assert.ok(preview.backup.files.some((f) => f.path.endsWith("ProjectVersion.txt")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("createPreview：2020.3 硬门 422 VERSION_UNSUPPORTED，零 preview", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-preview-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root, { version: "2020.3.48f1" });
    await assert.rejects(() => createPreview(deps(dataDir), project), (e: any) =>
      e.code === "INVALID_INPUT" && e.status === 422 && e.details?.code === "UNITY_INSTALL_VERSION_UNSUPPORTED");
    const previews = join(dataDir, "unity-install", "previews");
    assert.equal(existsSync(previews) ? readdirSync(previews).length : 0, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("createPreview：同包同 URL -> none、diff 空、manifest 不变", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-preview-"));
  try {
    const dataDir = join(root, "data");
    const manifest = '{\n  "dependencies": {\n    "' + UNITY_MCP_PACKAGE_ID + '": "' + UNITY_MCP_PACKAGE_URL + '"\n  }\n}\n';
    const project = makeProject(root, { manifest });
    const manifestPath = join(project, "Packages", "manifest.json");
    const before = readFileSync(manifestPath);
    const preview = await createPreview(deps(dataDir), project);
    assert.equal(preview.package.change, "none");
    assert.equal(preview.diff, "");
    assert.equal(readFileSync(manifestPath).equals(before), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("createPreview：不同版本 -> replace、diff 含 -/+", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-preview-"));
  try {
    const dataDir = join(root, "data");
    const manifest = '{\n  "dependencies": {\n    "' + UNITY_MCP_PACKAGE_ID + '": "https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#v9.0.0"\n  }\n}\n';
    const project = makeProject(root, { manifest });
    const preview = await createPreview(deps(dataDir), project);
    assert.equal(preview.package.change, "replace");
    assert.equal(preview.package.current?.version, "9.0.0");
    assert.ok(preview.diff.includes("-"));
    assert.ok(preview.diff.includes("+"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("createPreview：本地路径 -> conflict + warning", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-preview-"));
  try {
    const dataDir = join(root, "data");
    const manifest = '{\n  "dependencies": {\n    "' + UNITY_MCP_PACKAGE_ID + '": "file:../local"\n  }\n}\n';
    const project = makeProject(root, { manifest });
    const preview = await createPreview(deps(dataDir), project);
    assert.equal(preview.package.change, "conflict");
    assert.ok(preview.warnings.some((w) => w.includes("冲突")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("createPreview：dependencies [] -> conflict preview，空 diff，apply 409 零写", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-preview-"));
  try {
    const dataDir = join(root, "data");
    const manifest = '{\n  "dependencies": []\n}\n';
    const project = makeProject(root, { manifest });
    const manifestPath = join(project, "Packages", "manifest.json");
    const before = readFileSync(manifestPath);
    const preview = await createPreview(deps(dataDir), project);
    assert.equal(preview.package.change, "conflict");
    assert.equal(preview.diff, "");
    assert.ok(preview.warnings.some((w) => w.includes("冲突")));
    assert.equal(readFileSync(manifestPath).equals(before), true);
    assert.equal(existsSync(join(dataDir, "unity-install", "previews", preview.previewId + ".json")), true);
    await assert.rejects(() => applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true }), (e: any) =>
      e.code === "CONFLICT" && e.details?.code === "UNITY_INSTALL_CONFLICT");
    assert.equal(readFileSync(manifestPath).equals(before), true);
    const opsDir = join(dataDir, "unity-install", "operations");
    assert.equal(existsSync(opsDir) ? readdirSync(opsDir).length : 0, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("createPreview：dependencies null -> conflict preview，空 diff，apply 409 零写", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-preview-"));
  try {
    const dataDir = join(root, "data");
    const manifest = '{\n  "dependencies": null\n}\n';
    const project = makeProject(root, { manifest });
    const manifestPath = join(project, "Packages", "manifest.json");
    const before = readFileSync(manifestPath);
    const preview = await createPreview(deps(dataDir), project);
    assert.equal(preview.package.change, "conflict");
    assert.equal(preview.diff, "");
    assert.ok(preview.warnings.some((w) => w.includes("冲突")));
    assert.equal(readFileSync(manifestPath).equals(before), true);
    assert.equal(existsSync(join(dataDir, "unity-install", "previews", preview.previewId + ".json")), true);
    await assert.rejects(() => applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true }), (e: any) =>
      e.code === "CONFLICT" && e.details?.code === "UNITY_INSTALL_CONFLICT");
    assert.equal(readFileSync(manifestPath).equals(before), true);
    const opsDir = join(dataDir, "unity-install", "operations");
    assert.equal(existsSync(opsDir) ? readdirSync(opsDir).length : 0, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
